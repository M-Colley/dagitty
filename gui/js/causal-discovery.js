/* Causal Discovery Module for DAGitty
 *
 * Implements:
 *  1. PC Algorithm (Spirtes, Glymour & Scheines 1993, PC-stable variant)
 *     — learns an undirected skeleton via partial-correlation / Fisher Z tests
 *     — orients v-structures and applies Meek orientation rules R1-R3
 *
 *  2. Pairwise LiNGAM orientation heuristic
 *     (LiNGAM: Shimizu et al. 2006, https://www.jmlr.org/papers/v7/shimizu06a.html;
 *      pairwise variant inspired by Hyvärinen & Smith 2013, simplified for the browser)
 *     — for each undirected edge left by PC, fits linear regression in both
 *       directions and picks the direction with more Gaussian-like residuals,
 *       because in the correct causal direction X→Y the residuals should be
 *       independent from (and thus less coupled to) the cause X.
 *
 *  3. Correlation-based skeleton (fast exploratory scan)
 *
 * Usage:
 *   var result = CausalDiscovery.discoverFromCSV(csvText, alpha, useLingam);
 *   // result.modelCode  — DAGitty model string ready to paste / load
 *   // result.edgeCount
 *   // result.undirectedCount — edges left ambiguous (shown as <->)
 *   // result.warnings  — array of strings
 */

var CausalDiscovery = (function () {
    'use strict';

    // ── CSV Parsing ───────────────────────────────────────────────────────────

    /**
     * Parse a CSV / TSV / semicolon-delimited string.
     *
     * Strategy:
     *  1. Auto-detect separator (tab > semicolon > comma).
     *  2. Parse every data row.
     *  3. For each column, count how many cells are parseable as a number.
     *     A column is considered "numeric" if ≥ 80 % of its non-empty cells
     *     are numbers AND it has at least 3 distinct values (excludes constant
     *     or near-constant ID-like columns).
     *  4. Text / ID columns are silently dropped with a warning.
     *  5. For numeric columns, rows that have a non-numeric cell in that
     *     column are excluded (NaN → row skipped for that column).
     *
     * Returns { headers, data, droppedCols, skipped }
     */
    function parseCSV(text) {
        if (!text || !text.trim()) throw new Error('No data provided.');
        var lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) throw new Error('File must have a header row plus at least one data row.');

        // Auto-detect separator: prefer tab, then semicolon, then comma
        var firstLine = lines[0];
        var sep;
        var tabCount   = (firstLine.match(/\t/g)   || []).length;
        var semiCount  = (firstLine.match(/;/g)     || []).length;
        var commaCount = (firstLine.match(/,/g)     || []).length;
        if (tabCount >= semiCount && tabCount >= commaCount)       sep = '\t';
        else if (semiCount >= commaCount)                           sep = ';';
        else                                                        sep = ',';

        function splitRow(line) {
            var result = [], cur = '', inQ = false;
            for (var i = 0; i < line.length; i++) {
                var c = line[i];
                if (c === '"') { inQ = !inQ; }
                else if (c === sep && !inQ) { result.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
                else { cur += c; }
            }
            result.push(cur.trim().replace(/^"|"$/g, ''));
            return result;
        }

        // Parse header row
        var allHeaders = splitRow(lines[0]).map(function(h){ return h.trim(); });
        // Remove trailing empty headers
        while (allHeaders.length && allHeaders[allHeaders.length-1] === '') allHeaders.pop();
        if (allHeaders.length < 2) throw new Error('Need at least 2 columns.');

        var p = allHeaders.length;

        // Parse all data rows as raw strings first
        var rawRows = [];
        for (var i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            rawRows.push(splitRow(lines[i]));
        }
        if (rawRows.length < 3) throw new Error('Need at least 3 data rows (got ' + rawRows.length + ').');

        // Determine which columns are numeric:
        // count parseable numbers and distinct values per column
        var numericCount = new Array(p).fill(0);
        var nonEmptyCount = new Array(p).fill(0);
        var allInteger = new Array(p).fill(true);   // does the column hold only integers?
        var distinctVals = [];
        for (var c = 0; c < p; c++) distinctVals.push({});

        rawRows.forEach(function(row) {
            for (var c = 0; c < p; c++) {
                var cell = (row[c] || '').trim();
                if (cell === '' || cell === 'NA' || cell === 'N/A' || cell === 'nan' || cell === 'NaN') continue;
                nonEmptyCount[c]++;
                var v = parseFloat(cell);
                if (!isNaN(v)) {
                    numericCount[c]++;
                    distinctVals[c][v] = 1;
                    if (v !== Math.floor(v)) allInteger[c] = false;
                }
            }
        });

        var numericCols = [];   // indices
        var droppedCols = [];

        // Detect identifier / metadata columns by name.
        // Conservative — only matches patterns that are almost certainly
        // NOT measurement variables (avoids false positives on "reactionTime",
        // "trialDuration", "sessionOrder", etc.).
        function isIdentifierColumn(name) {
            // Ends with separator + "id": user_id, subject.id, participant-id
            if (/[_.\-]id$/i.test(name)) return true;
            // CamelCase/PascalCase ending: ProlificID, SubjectId
            // (case-sensitive to avoid matching "valid", "grid", "android")
            if (/[a-z](?:ID|Id)$/.test(name)) return true;
            // Exact "id" / "uuid" / "guid"
            if (/^(?:id|uuid|guid)$/i.test(name)) return true;
            // Platform-specific identifiers anywhere in name
            if (/prolific|mturk|qualtrics/i.test(name)) return true;
            // Exact role-based names (full match only — avoids "subjective")
            if (/^(?:participant|respondent|subject|subj|ppt|worker)$/i.test(name)) return true;
            return false;
        }

        for (var c = 0; c < p; c++) {
            var colName  = allHeaders[c];
            var total    = nonEmptyCount[c];

            // 1. Name-based ID check (catches ProlificID, SubjectID, etc.)
            if (isIdentifierColumn(colName)) {
                droppedCols.push(colName + ' (identifier column)');
                continue;
            }

            if (total === 0) { droppedCols.push(colName + ' (empty)'); continue; }
            var fracNumeric  = numericCount[c] / total;
            var nDistinct    = Object.keys(distinctVals[c]).length;
            var fracDistinct = nDistinct / total;  // uniqueness ratio

            // 2. Require ≥80% numeric and ≥2 distinct values. Continuous
            //    measurements are kept regardless of uniqueness — they are
            //    naturally near-unique (every float differs). Only flag a column
            //    as an identifier when it is integer-valued AND almost every row
            //    is unique (e.g. a 1..N row index), and only on larger samples
            //    where that pattern is meaningful.
            if (fracNumeric >= 0.8 && nDistinct >= 2) {
                if (allInteger[c] && total >= 20 && fracDistinct > 0.99) {
                    droppedCols.push(colName + ' (ID-like — unique integer per row)');
                } else {
                    numericCols.push(c);
                }
            } else {
                droppedCols.push(colName);
            }
        }

        if (numericCols.length < 2) {
            var hint = droppedCols.length
                ? ' Dropped non-numeric columns: ' + droppedCols.slice(0, 6).join(', ') + '.'
                : '';
            throw new Error('Need at least 2 numeric columns.' + hint);
        }

        var headers = numericCols.map(function(c){ return allHeaders[c]; });

        // Build data rows using only numeric columns; skip rows with missing values
        var data = [], skippedRows = 0;
        rawRows.forEach(function(row) {
            var obj = {}, ok = true;
            for (var ci = 0; ci < numericCols.length; ci++) {
                var c = numericCols[ci];
                var cell = (row[c] || '').trim();
                if (cell === '' || cell === 'NA' || cell === 'N/A' || cell === 'nan' || cell === 'NaN') {
                    ok = false; break;
                }
                var v = parseFloat(cell);
                if (isNaN(v)) { ok = false; break; }
                obj[headers[ci]] = v;
            }
            if (ok) data.push(obj);
            else skippedRows++;
        });

        if (data.length < 5) {
            throw new Error(
                'Need at least 5 complete rows in numeric columns (got ' + data.length + '). ' +
                (skippedRows ? skippedRows + ' row(s) had missing values.' : '')
            );
        }

        return { headers: headers, data: data, droppedCols: droppedCols, skipped: skippedRows };
    }

    // ── Statistics ────────────────────────────────────────────────────────────

    function mean(arr) {
        var s = 0;
        for (var i = 0; i < arr.length; i++) s += arr[i];
        return s / arr.length;
    }

    function variance(arr) {
        var m = mean(arr), s = 0;
        for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
        return s / (arr.length - 1);
    }

    function stddev(arr) { return Math.sqrt(variance(arr)); }

    function pearsonR(x, y) {
        var n = x.length, mx = mean(x), my = mean(y);
        var num = 0, dx2 = 0, dy2 = 0;
        for (var i = 0; i < n; i++) {
            var dx = x[i] - mx, dy = y[i] - my;
            num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
        }
        var denom = Math.sqrt(dx2 * dy2);
        return denom < 1e-14 ? 0 : num / denom;
    }

    /** n×n Pearson correlation matrix from {header: value} rows. */
    function correlationMatrix(data, vars) {
        var p = vars.length;
        var cols = vars.map(function(v){ return data.map(function(r){ return r[v]; }); });
        var C = [];
        for (var i = 0; i < p; i++) {
            C.push([]);
            for (var j = 0; j < p; j++) {
                C[i].push(i === j ? 1 : pearsonR(cols[i], cols[j]));
            }
        }
        return C;
    }

    /** Invert a square matrix using Gauss-Jordan. Returns null if singular. */
    function invertMatrix(M) {
        var n = M.length;
        // Build augmented [M | I]
        var A = [];
        for (var i = 0; i < n; i++) {
            A.push(M[i].slice());
            for (var j = 0; j < n; j++) A[i].push(i === j ? 1 : 0);
        }
        for (var col = 0; col < n; col++) {
            // Find pivot
            var maxRow = col;
            for (var row = col + 1; row < n; row++) {
                if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
            }
            var tmp = A[col]; A[col] = A[maxRow]; A[maxRow] = tmp;
            var piv = A[col][col];
            if (Math.abs(piv) < 1e-12) return null;
            for (var j2 = 0; j2 < 2 * n; j2++) A[col][j2] /= piv;
            for (var r = 0; r < n; r++) {
                if (r === col) continue;
                var f = A[r][col];
                for (var j3 = 0; j3 < 2 * n; j3++) A[r][j3] -= f * A[col][j3];
            }
        }
        return A.map(function(row){ return row.slice(n); });
    }

    /**
     * Partial correlation of vars[i] and vars[j] given condSet (array of indices).
     * Uses submatrix inversion: pcorr = −inv[0,1] / sqrt(inv[0,0]·inv[1,1])
     */
    function partialCorr(C, i, j, condSet) {
        if (condSet.length === 0) return C[i][j];
        var idx = [i, j].concat(condSet);
        var sub = idx.map(function(r){ return idx.map(function(c){ return C[r][c]; }); });
        var inv = invertMatrix(sub);
        if (!inv) return 0;
        var denom = Math.sqrt(Math.abs(inv[0][0] * inv[1][1]));
        return denom < 1e-12 ? 0 : -inv[0][1] / denom;
    }

    // ── Statistical test ──────────────────────────────────────────────────────

    /** Approximate normal CDF via erf polynomial (Abramowitz & Stegun 7.1.26). */
    function normalCDF(x) {
        var t = 1 / (1 + 0.3275911 * Math.abs(x));
        var p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
        var v = 1 - p * Math.exp(-x * x);
        return x >= 0 ? 0.5 * (1 + v) : 0.5 * (1 - v);
    }

    /**
     * Two-sided Fisher Z p-value for H₀: partial correlation = 0.
     * n = sample size, k = size of conditioning set.
     */
    function fisherZPVal(r, n, k) {
        var z = 0.5 * Math.log((1 + Math.min(0.9999, Math.abs(r))) / (1 - Math.min(0.9999, Math.abs(r))));
        var se = 1 / Math.sqrt(Math.max(1, n - k - 3));
        var stat = Math.abs(z / se);
        return 2 * (1 - normalCDF(stat));
    }

    // ── Subset enumeration ────────────────────────────────────────────────────

    function subsetsOfSize(arr, k) {
        if (k === 0) return [[]];
        if (k > arr.length) return [];
        var result = [];
        function bt(start, cur) {
            if (cur.length === k) { result.push(cur.slice()); return; }
            for (var i = start; i < arr.length; i++) {
                cur.push(arr[i]); bt(i + 1, cur); cur.pop();
            }
        }
        bt(0, []);
        return result;
    }

    // ── Async helper ──────────────────────────────────────────────────────────

    /** Yield control to the browser for one animation frame, then continue. */
    function yieldToUI() {
        return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    // ── PC Algorithm (async, with progress callbacks) ─────────────────────────

    /**
     * PC-stable algorithm — async version.
     * Yields to the UI between each conditioning-set level AND within each
     * level (every YIELD_EVERY pairs) so the browser stays responsive even
     * with large datasets.
     *
     * @param {Object[]} data       - array of {varName: number} rows
     * @param {string[]} vars       - variable names
     * @param {number}   alpha      - significance level
     * @param {Function} onProgress - called with (pct 0-100, label string)
     * @param {Object}   [opts]     - options:
     *   opts.maxCondSize  {number}  max conditioning-set depth (default 3)
     *   opts.corrThreshold {number} pre-prune edges with |r| < threshold (default 0)
     * @returns {Promise<{adj, dirAdj, sepset, vars, corrMat}>}
     */
    function pcAlgorithmAsync(data, vars, alpha, onProgress, opts) {
        var prog        = onProgress || function () {};
        opts            = opts || {};
        var maxCondSize = (opts.maxCondSize  !== undefined) ? opts.maxCondSize  : 3;
        var corrThr     = (opts.corrThreshold !== undefined) ? opts.corrThreshold : 0;
        var YIELD_EVERY = 40;   // yield to UI every N pairs within a level

        var n = data.length, p = vars.length;

        return yieldToUI().then(function () {

            prog(5, 'Computing correlation matrix…');
            var C = correlationMatrix(data, vars);

            // Fully connected skeleton
            var adj = [];
            for (var i = 0; i < p; i++) {
                adj.push([]);
                for (var j = 0; j < p; j++) adj[i].push(i !== j);
            }

            // Separation sets — must be initialised before pre-pruning
            var sepset = [];
            for (var i2 = 0; i2 < p; i2++) {
                sepset.push([]);
                for (var j2 = 0; j2 < p; j2++) sepset[i2].push(null);
            }

            // Correlation pre-pruning: immediately remove edges whose
            // marginal |r| is below the threshold (treats them as
            // independent given the empty conditioning set).
            // IMPORTANT: also record sepset = [] so that v-structure
            // detection can correctly identify colliders among these pairs.
            var prunedCount = 0;
            if (corrThr > 0) {
                for (var pi = 0; pi < p; pi++) {
                    for (var pj = pi + 1; pj < p; pj++) {
                        if (Math.abs(C[pi][pj]) < corrThr) {
                            adj[pi][pj] = adj[pj][pi] = false;
                            sepset[pi][pj] = sepset[pj][pi] = [];  // empty conditioning set
                            prunedCount++;
                        }
                    }
                }
                if (prunedCount > 0)
                    prog(8, 'Pre-pruned ' + prunedCount + ' weak edges (|r| < ' + corrThr + ')…');
            }

            var condSize = 0;
            var hardMax  = Math.min(maxCondSize, p - 2);

            // Process one level, yielding every YIELD_EVERY pairs so the UI
            // stays alive even during large skeleton searches.
            function doLevel() {
                if (condSize > hardMax) return Promise.resolve();

                var levelPct = Math.round(10 + 60 * (1 - Math.pow(0.55, condSize)));
                prog(levelPct, 'Skeleton search — conditioning set size ' + condSize +
                    (condSize === hardMax ? ' (max)' : '') + '…');

                // Collect all pairs to test at this level first
                var pairs = [];
                for (var xi = 0; xi < p; xi++) {
                    for (var xj = xi + 1; xj < p; xj++) {
                        if (!adj[xi][xj]) continue;
                        var nbrs = [];
                        for (var k = 0; k < p; k++) {
                            if (k !== xi && k !== xj && adj[xi][k]) nbrs.push(k);
                        }
                        if (nbrs.length >= condSize) pairs.push({ i: xi, j: xj, nbrs: nbrs });
                    }
                }

                if (pairs.length === 0) return Promise.resolve(); // done

                var toRemove = [];
                var pairIdx  = 0;

                // Process pairs in batches, yielding between batches
                function doBatch() {
                    var end = Math.min(pairIdx + YIELD_EVERY, pairs.length);
                    for (; pairIdx < end; pairIdx++) {
                        var pair = pairs[pairIdx];
                        var xi2  = pair.i, xj2 = pair.j;
                        if (!adj[xi2][xj2]) continue; // may have been removed earlier in this level
                        var subs = subsetsOfSize(pair.nbrs, condSize);
                        for (var s = 0; s < subs.length; s++) {
                            var r = partialCorr(C, xi2, xj2, subs[s]);
                            if (fisherZPVal(r, n, subs[s].length) > alpha) {
                                toRemove.push({ i: xi2, j: xj2, S: subs[s] });
                                break;
                            }
                        }
                    }

                    if (pairIdx < pairs.length) {
                        // Update progress within the level
                        var withinPct = Math.round(levelPct + (pairIdx / pairs.length) *
                            (Math.round(10 + 60 * (1 - Math.pow(0.55, condSize + 1))) - levelPct) * 0.8);
                        prog(Math.min(withinPct, 69),
                            'Skeleton (level ' + condSize + ') — ' + pairIdx + ' / ' + pairs.length + ' pairs…');
                        return yieldToUI().then(doBatch);
                    }

                    // Commit removals for this level
                    for (var ri = 0; ri < toRemove.length; ri++) {
                        var rem = toRemove[ri];
                        adj[rem.i][rem.j] = adj[rem.j][rem.i] = false;
                        sepset[rem.i][rem.j] = sepset[rem.j][rem.i] = rem.S;
                    }

                    condSize++;
                    return yieldToUI().then(doLevel);
                }

                return yieldToUI().then(doBatch);
            }

            return doLevel().then(function () {

                prog(72, 'Orienting v-structures…');
                return yieldToUI();

            }).then(function () {

                // Directed adjacency
                var dirAdj = [];
                for (var di = 0; di < p; di++) {
                    dirAdj.push([]);
                    for (var dj = 0; dj < p; dj++) dirAdj[di].push(false);
                }

                // V-structures
                for (var vi = 0; vi < p; vi++) {
                    for (var vj = vi + 1; vj < p; vj++) {
                        if (adj[vi][vj]) continue;
                        for (var vk = 0; vk < p; vk++) {
                            if (vk === vi || vk === vj) continue;
                            if (!adj[vi][vk] || !adj[vj][vk]) continue;
                            var sep = sepset[vi][vj];
                            if (sep !== null && sep.indexOf(vk) === -1) {
                                if (!dirAdj[vk][vi] && !dirAdj[vk][vj]) {
                                    dirAdj[vi][vk] = dirAdj[vj][vk] = true;
                                    adj[vi][vk] = adj[vk][vi] = false;
                                    adj[vj][vk] = adj[vk][vj] = false;
                                }
                            }
                        }
                    }
                }

                prog(80, 'Applying Meek orientation rules…');
                return yieldToUI().then(function () {

                    // Meek rules R1 + R2
                    var changed = true, iters = 0;
                    while (changed && iters < 200) {
                        changed = false; iters++;
                        // R1: a→k—j and a∤j  ⟹  k→j
                        // "a∤j" means no edge between a and j (directed or undirected)
                        for (var a = 0; a < p; a++) {
                            for (var kk = 0; kk < p; kk++) {
                                if (!dirAdj[a][kk]) continue;
                                for (var jj = 0; jj < p; jj++) {
                                    if (jj === a || jj === kk) continue;
                                    if (!adj[kk][jj]) continue;          // kk—jj must be undirected
                                    // a and jj must be non-adjacent (no edge of any kind)
                                    if (adj[a][jj] || dirAdj[a][jj] || dirAdj[jj][a]) continue;
                                    adj[kk][jj] = adj[jj][kk] = false;
                                    dirAdj[kk][jj] = true;
                                    changed = true;
                                }
                            }
                        }
                        for (var a2 = 0; a2 < p; a2++) {
                            for (var c2 = 0; c2 < p; c2++) {
                                if (a2 === c2 || !adj[a2][c2]) continue;
                                for (var b2 = 0; b2 < p; b2++) {
                                    if (b2 === a2 || b2 === c2 || !dirAdj[a2][b2] || !dirAdj[b2][c2]) continue;
                                    adj[a2][c2] = adj[c2][a2] = false;
                                    dirAdj[a2][c2] = true;
                                    changed = true;
                                }
                            }
                        }
                    }

                    return { adj: adj, dirAdj: dirAdj, sepset: sepset, vars: vars, corrMat: C };
                });
            });
        });
    }

    // Keep synchronous version for backward compatibility / testing
    function pcAlgorithm(data, vars, alpha) {
        // Run the async version but block — only used in non-UI contexts
        var result;
        // Inline the sync logic (same as above without yields)
        var n = data.length, p = vars.length;
        var C = correlationMatrix(data, vars);
        var adj = [];
        for (var i = 0; i < p; i++) { adj.push([]); for (var j = 0; j < p; j++) adj[i].push(i !== j); }
        var sepset = [];
        for (var i2 = 0; i2 < p; i2++) { sepset.push([]); for (var j2 = 0; j2 < p; j2++) sepset[i2].push(null); }
        for (var condSize = 0; condSize <= p - 2; condSize++) {
            var toRemove = []; var anyAtThisLevel = false;
            for (var xi = 0; xi < p; xi++) {
                for (var xj = xi + 1; xj < p; xj++) {
                    if (!adj[xi][xj]) continue;
                    var nbrs = [];
                    for (var k = 0; k < p; k++) { if (k !== xi && k !== xj && adj[xi][k]) nbrs.push(k); }
                    if (nbrs.length < condSize) continue;
                    anyAtThisLevel = true;
                    var subs = subsetsOfSize(nbrs, condSize);
                    for (var s = 0; s < subs.length; s++) {
                        var r = partialCorr(C, xi, xj, subs[s]);
                        if (fisherZPVal(r, n, subs[s].length) > alpha) { toRemove.push({ i: xi, j: xj, S: subs[s] }); break; }
                    }
                }
            }
            for (var ri = 0; ri < toRemove.length; ri++) { var rem = toRemove[ri]; adj[rem.i][rem.j] = adj[rem.j][rem.i] = false; sepset[rem.i][rem.j] = sepset[rem.j][rem.i] = rem.S; }
            if (!anyAtThisLevel) break;
        }
        var dirAdj = [];
        for (var di = 0; di < p; di++) { dirAdj.push([]); for (var dj = 0; dj < p; dj++) dirAdj[di].push(false); }
        for (var vi = 0; vi < p; vi++) {
            for (var vj = vi + 1; vj < p; vj++) {
                if (adj[vi][vj]) continue;
                for (var vk = 0; vk < p; vk++) {
                    if (vk === vi || vk === vj || !adj[vi][vk] || !adj[vj][vk]) continue;
                    var sep = sepset[vi][vj];
                    if (sep !== null && sep.indexOf(vk) === -1 && !dirAdj[vk][vi] && !dirAdj[vk][vj]) {
                        dirAdj[vi][vk] = dirAdj[vj][vk] = true;
                        adj[vi][vk] = adj[vk][vi] = adj[vj][vk] = adj[vk][vj] = false;
                    }
                }
            }
        }
        var changed = true, iters = 0;
        while (changed && iters < 200) {
            changed = false; iters++;
            // R1: a→k—j and a∤j ⟹ k→j  (a∤j = no edge of any kind)
            for (var a = 0; a < p; a++) { for (var kk = 0; kk < p; kk++) { if (!dirAdj[a][kk]) continue; for (var jj = 0; jj < p; jj++) { if (jj===a||jj===kk||!adj[kk][jj]||adj[a][jj]||dirAdj[a][jj]||dirAdj[jj][a]) continue; adj[kk][jj]=adj[jj][kk]=false; dirAdj[kk][jj]=true; changed=true; } } }
            for (var a2 = 0; a2 < p; a2++) { for (var c2 = 0; c2 < p; c2++) { if (a2===c2||!adj[a2][c2]) continue; for (var b2 = 0; b2 < p; b2++) { if (b2===a2||b2===c2||!dirAdj[a2][b2]||!dirAdj[b2][c2]) continue; adj[a2][c2]=adj[c2][a2]=false; dirAdj[a2][c2]=true; changed=true; } } }
        }
        return { adj: adj, dirAdj: dirAdj, sepset: sepset, vars: vars, corrMat: C };
    }

    // ── LiNGAM-inspired pairwise orientation ──────────────────────────────────

    /**
     * For a pair (xi, xj) decide direction using the Hyvärinen-Smith (2013)
     * residual-independence criterion:
     *   - fit xj = a·xi + c_a + e_a  (xi → xj model, OLS with intercept)
     *   - fit xi = b·xj + c_b + e_b  (xj → xi model, OLS with intercept)
     *   - score(xi→xj) = |corr(xi, e_a²)|  — how dependent is the cause on
     *     the squared residuals? Lower = more independent = more likely correct.
     *   - pick the direction with the LOWER score.
     * Returns true if xi → xj, false if xj → xi.
     */
    function lingamDir(xi, xj) {
        var mx = mean(xi), my = mean(xj);
        var num = 0, dx2 = 0, dy2 = 0;
        for (var i = 0; i < xi.length; i++) {
            var dxi = xi[i] - mx, dxj = xj[i] - my;
            num += dxi * dxj; dx2 += dxi * dxi; dy2 += dxj * dxj;
        }
        // OLS slopes (with intercept absorbed into deviation form)
        var a = (dx2 > 1e-14) ? num / dx2 : 0;  // xj = a·xi + (my - a·mx) + e_a
        var b = (dy2 > 1e-14) ? num / dy2 : 0;  // xi = b·xj + (mx - b·my) + e_b

        // Correct OLS residuals include the intercept:
        //   e_a[i] = (xj[i] - my) - a·(xi[i] - mx)
        //   e_b[i] = (xi[i] - mx) - b·(xj[i] - my)
        var ea = [], eb = [];
        for (var i = 0; i < xi.length; i++) {
            ea.push((xj[i] - my) - a * (xi[i] - mx));
            eb.push((xi[i] - mx) - b * (xj[i] - my));
        }

        // Dependence measure: |corr(cause, residual²)|
        var ea2 = ea.map(function(e){ return e * e; });
        var eb2 = eb.map(function(e){ return e * e; });

        var scoreXtoY = Math.abs(pearsonR(xi, ea2));   // xi → xj direction
        var scoreYtoX = Math.abs(pearsonR(xj, eb2));   // xj → xi direction

        return scoreXtoY <= scoreYtoX; // true = xi → xj
    }

    /**
     * Apply LiNGAM pairwise test to remaining undirected edges in-place.
     * Modifies adj and dirAdj.
     */
    function applyLiNGAM(result, data, vars) {
        var adj = result.adj, dirAdj = result.dirAdj, p = vars.length;
        for (var i = 0; i < p; i++) {
            for (var j = i + 1; j < p; j++) {
                if (!adj[i][j]) continue;
                var xi = data.map(function(row){ return row[vars[i]]; });
                var xj = data.map(function(row){ return row[vars[j]]; });
                var iToJ = lingamDir(xi, xj);
                adj[i][j] = adj[j][i] = false;
                if (iToJ) dirAdj[i][j] = true;
                else       dirAdj[j][i] = true;
            }
        }
    }

    // ── Format output as DAGitty model code ───────────────────────────────────

    /**
     * Convert PC/LiNGAM result to a DAGitty model code string.
     * Undirected edges (if any remain) are rendered as bidirected (<->).
     */
    function toModelCode(result, vars) {
        var adj = result.adj, dirAdj = result.dirAdj, p = vars.length;

        // Circular layout (radius 2, so coordinates fit DAGitty's default viewport)
        function pos(i) {
            var angle = (2 * Math.PI * i / p) - Math.PI / 2;
            return {
                x: Math.round(Math.cos(angle) * 200) / 100,
                y: Math.round(Math.sin(angle) * 200) / 100
            };
        }

        // Sanitise variable name for DAGitty (wrap in quotes if needed)
        function qv(v) {
            return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(v) ? v : '"' + v.replace(/"/g, '\\"') + '"';
        }

        var lines = ['dag {'];

        // Nodes
        for (var i = 0; i < p; i++) {
            var p2 = pos(i);
            lines.push('  ' + qv(vars[i]) + ' [pos="' + p2.x + ',' + p2.y + '"]');
        }

        // Directed edges
        for (var ii = 0; ii < p; ii++) {
            for (var jj = 0; jj < p; jj++) {
                if (dirAdj[ii][jj]) lines.push('  ' + qv(vars[ii]) + ' -> ' + qv(vars[jj]));
            }
        }

        // Remaining undirected edges (bidirected proxy)
        for (var ui = 0; ui < p; ui++) {
            for (var uj = ui + 1; uj < p; uj++) {
                if (adj[ui][uj]) lines.push('  ' + qv(vars[ui]) + ' <-> ' + qv(vars[uj]));
            }
        }

        lines.push('}');
        return lines.join('\n');
    }

    // ── Count helpers ─────────────────────────────────────────────────────────

    function countEdges(result) {
        var adj = result.adj, dirAdj = result.dirAdj, p = result.vars.length;
        var dir = 0, undir = 0;
        for (var i = 0; i < p; i++) {
            for (var j = i + 1; j < p; j++) {
                if (dirAdj[i][j] || dirAdj[j][i]) dir++;
                else if (adj[i][j]) undir++;
            }
        }
        return { directed: dir, undirected: undir };
    }

    // ── Main entry point ──────────────────────────────────────────────────────

    /**
     * Full pipeline: parse CSV → PC algorithm → optional LiNGAM → DAGitty code.
     *
     * @param {string}  csvText   Raw CSV text
     * @param {number}  alpha     Significance level (default 0.05)
     * @param {boolean} useLingam Whether to apply LiNGAM orientation (default true)
     * @returns {{ modelCode, nodeCount, edgeCount, undirectedCount, warnings, n }}
     */
    function discoverFromCSV(csvText, alpha, useLingam) {
        if (alpha === undefined) alpha = 0.05;
        if (useLingam === undefined) useLingam = true;

        var parsed = parseCSV(csvText);
        var headers = parsed.headers, data = parsed.data, n = data.length;
        var warnings = [];

        if (parsed.droppedCols && parsed.droppedCols.length > 0)
            warnings.push('Skipped ' + parsed.droppedCols.length + ' non-numeric column(s): ' +
                parsed.droppedCols.slice(0, 8).join(', ') +
                (parsed.droppedCols.length > 8 ? '…' : '') + '.');
        if (parsed.skipped > 0) warnings.push(parsed.skipped + ' row(s) skipped (missing values).');
        if (n < 30)  warnings.push('Small sample (' + n + ' rows). Results may be unreliable.');
        if (n < 100) warnings.push('Causal discovery works best with 100+ observations.');
        if (headers.length > 15) warnings.push('Many variables (' + headers.length + '). Analysis may be slow and less reliable.');

        var result = pcAlgorithm(data, headers, alpha);

        if (useLingam) {
            applyLiNGAM(result, data, headers);
            // Check if LiNGAM was able to orient all edges
            var leftUndir = 0;
            for (var i = 0; i < headers.length; i++)
                for (var j = i+1; j < headers.length; j++)
                    if (result.adj[i][j]) leftUndir++;
            if (leftUndir > 0) warnings.push(leftUndir + ' edge(s) could not be oriented — shown as bidirected (<->).');
        }

        var counts = countEdges(result);
        var modelCode = toModelCode(result, headers);

        return {
            modelCode: modelCode,
            nodeCount: headers.length,
            edgeCount: counts.directed + counts.undirected,
            directedCount: counts.directed,
            undirectedCount: counts.undirected,
            warnings: warnings,
            n: n
        };
    }

    /**
     * Async pipeline with progress callbacks — use this in the UI.
     *
     * @param {string}   csvText
     * @param {number}   alpha
     * @param {boolean}  useLingam
     * @param {Function} onProgress(pct 0-100, label string)
     * @param {Object}   [opts]  - forwarded to pcAlgorithmAsync:
     *   opts.maxCondSize   {number}  max conditioning-set depth (default 3)
     *   opts.corrThreshold {number}  pre-prune edges with |r| < threshold (default 0.05)
     * @returns {Promise<{ modelCode, nodeCount, edgeCount, directedCount, undirectedCount, warnings, n }>}
     */
    function discoverFromCSVAsync(csvText, alpha, useLingam, onProgress, opts) {
        if (alpha     === undefined) alpha     = 0.05;
        if (useLingam === undefined) useLingam = true;
        opts = opts || {};
        var prog = onProgress || function () {};

        var parsed, headers, data, n, warnings;

        // Step 1 — parse (fast, no yield needed)
        try {
            parsed   = parseCSV(csvText);
        } catch (e) {
            return Promise.reject(e);
        }

        headers  = parsed.headers;
        data     = parsed.data;
        n        = data.length;
        warnings = [];

        // Apply variable exclusions (from column-selection UI)
        if (opts.excludeVars && opts.excludeVars.length > 0) {
            var excl = {};
            opts.excludeVars.forEach(function (v) { excl[v] = true; });
            headers = headers.filter(function (h) { return !excl[h]; });
            data = data.map(function (row) {
                var obj = {};
                headers.forEach(function (h) { obj[h] = row[h]; });
                return obj;
            });
            if (headers.length < 2)
                return Promise.reject(new Error('Need at least 2 variables after exclusions.'));
        }

        if (parsed.droppedCols && parsed.droppedCols.length > 0)
            warnings.push('Skipped ' + parsed.droppedCols.length +
                ' non-numeric column(s): ' +
                parsed.droppedCols.slice(0, 8).join(', ') +
                (parsed.droppedCols.length > 8 ? '\u2026' : '') + '.');
        if (parsed.skipped > 0)
            warnings.push(parsed.skipped + ' row(s) had missing values and were skipped.');
        if (n < 30)
            warnings.push('Small sample (' + n + ' rows) \u2014 results may be unreliable.');
        if (n < 100)
            warnings.push('Causal discovery works best with 100+ observations.');
        if (n > 500 && headers.length > 8)
            warnings.push('If your data has repeated measures per participant, ' +
                'consider aggregating to participant means before uploading.');
        prog(3, 'Parsed ' + n + ' rows \u00D7 ' + headers.length + ' variables\u2026');

        // Default corrThreshold to 0.05 to pre-prune very weak marginal correlations
        if (opts.corrThreshold === undefined) opts.corrThreshold = 0.05;

        if (headers.length > 12)
            warnings.push('Large dataset (' + headers.length +
                ' variables). Using max conditioning-set depth ' +
                (opts.maxCondSize !== undefined ? opts.maxCondSize : 3) +
                ' to keep analysis tractable.');

        // Step 2 — PC algorithm (async, yields between levels AND within levels)
        return pcAlgorithmAsync(data, headers, alpha, prog, opts).then(function (result) {

            // Step 3 — LiNGAM orientation (fast enough to stay sync)
            if (useLingam) {
                prog(88, 'Applying LiNGAM orientation…');
                applyLiNGAM(result, data, headers);
                var leftUndir = 0;
                for (var i = 0; i < headers.length; i++)
                    for (var j = i + 1; j < headers.length; j++)
                        if (result.adj[i][j]) leftUndir++;
                if (leftUndir > 0)
                    warnings.push(leftUndir +
                        ' edge(s) could not be oriented — shown as bidirected (↔).');
            }

            prog(95, 'Building diagram…');

            var counts    = countEdges(result);
            var modelCode = toModelCode(result, headers);

            prog(100, 'Done.');

            return {
                modelCode:      modelCode,
                nodeCount:      headers.length,
                edgeCount:      counts.directed + counts.undirected,
                directedCount:  counts.directed,
                undirectedCount: counts.undirected,
                warnings:       warnings,
                n:              n,
                vars:           headers,
                corrMat:        result.corrMat
            };
        });
    }

    // Public API
    return {
        parseCSV:             parseCSV,
        pcAlgorithm:          pcAlgorithm,
        pcAlgorithmAsync:     pcAlgorithmAsync,
        applyLiNGAM:          applyLiNGAM,
        discoverFromCSV:      discoverFromCSV,
        discoverFromCSVAsync: discoverFromCSVAsync,
        correlationMatrix:    correlationMatrix,
        pearsonR:             pearsonR
    };

})();

// ── Web Worker mode ──────────────────────────────────────────────────────
// When loaded as a Worker (no window object), listen for analysis requests
// and post progress / results back to the main thread.
// This keeps the UI completely responsive during heavy computation.
if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = function (e) {
        var msg = e.data;
        if (msg.type === 'analyze') {
            try {
                CausalDiscovery.discoverFromCSVAsync(
                    msg.csvText, msg.alpha, msg.useLingam,
                    function (pct, label) {
                        self.postMessage({ type: 'progress', pct: pct, label: label });
                    },
                    msg.opts
                ).then(function (result) {
                    self.postMessage({ type: 'done', result: result });
                }).catch(function (err) {
                    self.postMessage({ type: 'error', message: err.message || String(err) });
                });
            } catch (err) {
                self.postMessage({ type: 'error', message: err.message || String(err) });
            }
        }
    };
}
