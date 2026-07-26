/* Causal Discovery Module for DAGitty
 *
 * Implements:
 *  1. PC Algorithm (Spirtes, Glymour & Scheines 1993, PC-stable variant)
 *     — learns an undirected skeleton via partial-correlation / Fisher Z tests
 *     — orients v-structures and applies Meek orientation rules R1-R3
 *
 *  2. DirectLiNGAM (Shimizu, Inazumi, Sogawa, Hyvärinen, Kawahara, Washio,
 *     Hoyer & Bollen 2011, JMLR 12:1225-1248,
 *     https://www.jmlr.org/papers/v12/shimizu11a.html)
 *     — a JavaScript port of `lingam.DirectLiNGAM` from the reference Python
 *       implementation (https://github.com/cdt15/lingam, v1.13.0): estimates a
 *       global causal order using an entropy-based mutual-information criterion,
 *       then orients every edge PC left ambiguous consistently with that order.
 *       PC's own orientations are supplied as prior knowledge.
 *
 *  3. Correlation-based skeleton (fast exploratory scan)
 *
 * Usage:
 *   var result = CausalDiscovery.discoverFromCSV(csvText, alpha, useLingam);
 *   // result.modelCode  — DAGitty model string ready to paste / load
 *   // result.edgeCount
 *   // result.undirectedCount — edges left ambiguous (shown as <->)
 *   // result.causalOrder — variable names, most exogenous first (DirectLiNGAM)
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

    // ── DirectLiNGAM orientation ──────────────────────────────────────────────
    //
    // Direct-LiNGAM (Shimizu, Inazumi, Sogawa, Hyvärinen, Kawahara, Washio,
    // Hoyer & Bollen 2011, JMLR 12:1225-1248), matching the reference Python
    // implementation `lingam.DirectLiNGAM` (cdt15/lingam v1.13.0).
    //
    // Rather than deciding each edge on its own, DirectLiNGAM estimates a single
    // global CAUSAL ORDER: it repeatedly picks the most exogenous remaining
    // variable, regresses it out of the others, and recurses. Two consequences
    // matter a lot here:
    //
    //   * every orientation is consistent with one total order, so the result
    //     cannot contain a cycle (the previous pairwise heuristic decided each
    //     edge independently and could easily produce A→B→C→A, which DAGitty
    //     then rejects as not a DAG);
    //   * the independence criterion is the entropy-based approximation of
    //     mutual information used by the reference implementation, which is
    //     considerably more reliable than the |corr(cause, residual²)| proxy
    //     used before.
    //
    // Orientations PC already established (v-structures and the Meek rules) are
    // passed in as prior knowledge, exactly as `DirectLiNGAM(prior_knowledge=…)`
    // does: a variable is only a candidate root while none of its known parents
    // are still unplaced.

    /** log(cosh(x)) without overflowing for large |x| (cosh(710) = Infinity). */
    function logCosh(x) {
        var a = Math.abs(x);
        return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2;
    }

    /**
     * Hyvärinen's (1998) maximum-entropy approximation of differential entropy,
     * the `_entropy` function of the reference implementation. Expects `u` to be
     * standardised (mean 0, sd 1).
     */
    function entropyApprox(u) {
        var k1 = 79.047, k2 = 7.4129, gamma = 0.37457;
        var n = u.length, s1 = 0, s2 = 0;
        for (var i = 0; i < n; i++) {
            var v = u[i];
            s1 += logCosh(v);
            s2 += v * Math.exp(-(v * v) / 2);
        }
        s1 /= n; s2 /= n;
        return (1 + Math.log(2 * Math.PI)) / 2 -
               k1 * (s1 - gamma) * (s1 - gamma) -
               k2 * s2 * s2;
    }

    /** Mean-0/sd-1 copy of an array. Returns null for a constant column. */
    function standardize(x) {
        var n = x.length, m = mean(x), s = 0;
        for (var i = 0; i < n; i++) { var d = x[i] - m; s += d * d; }
        s = Math.sqrt(s / (n - 1));
        if (!(s > 1e-12)) return null;
        var out = new Array(n);
        for (var j = 0; j < n; j++) out[j] = (x[j] - m) / s;
        return out;
    }

    /**
     * Residual of xi after regressing on xj, re-standardised — the `_residual`
     * step of DirectLiNGAM. Both inputs are assumed standardised, so the OLS
     * slope is just their covariance. Returns null if the residual vanishes
     * (xi and xj perfectly collinear).
     */
    function residualStd(xi, xj) {
        var n = xi.length, cov = 0;
        for (var i = 0; i < n; i++) cov += xi[i] * xj[i];
        cov /= (n - 1);
        var r = new Array(n);
        for (var k = 0; k < n; k++) r[k] = xi[k] - cov * xj[k];
        return standardize(r);
    }

    /**
     * One step of the causal-order search: return the most exogenous of the
     * remaining variables, i.e. the one whose independence-based score
     * `_diff_mutual_info` is least often negative against the others.
     *
     * `cols[i]` holds the current (already residualised) data for variable i,
     * `U` the indices still to be placed, and `candidates ⊆ U` the subset
     * allowed to be picked next given the prior knowledge.
     */
    function searchCausalOrder(cols, U, candidates) {
        if (candidates.length === 1) return candidates[0];

        // Standardise once per step and cache each variable's own entropy: it
        // does not depend on which partner it is compared against.
        var std = {}, ent = {};
        U.forEach(function (i) {
            var s = standardize(cols[i]);
            std[i] = s;
            ent[i] = s ? entropyApprox(s) : 0;
        });

        // H(residual of i regressed on j), memoised — every unordered pair is
        // otherwise scored twice, once from each end.
        var hCache = {};
        function hRes(i, j) {
            var k = i + ',' + j;
            if (k in hCache) return hCache[k];
            var r = residualStd(std[i], std[j]);
            return (hCache[k] = r ? entropyApprox(r) : null);
        }

        var best = candidates[0], bestM = Infinity;
        candidates.forEach(function (i) {
            if (!std[i]) return;                 // constant column: never a root
            var M = 0;
            U.forEach(function (j) {
                if (i === j || !std[j]) return;
                var hij = hRes(i, j), hji = hRes(j, i);
                if (hij === null || hji === null) return;
                // Negative ⇒ i → j is the better-supported direction; only the
                // negative part contributes, as in the reference implementation.
                var neg = Math.min(0, (ent[j] + hij) - (ent[i] + hji));
                M += neg * neg;
            });
            if (M < bestM) { bestM = M; best = i; }
        });
        return best;
    }

    /**
     * Estimate the full causal order with DirectLiNGAM.
     *
     * @param {Array}    cols        column arrays, one per variable
     * @param {Array}    dirAdj      PC's directed edges — used as prior knowledge
     * @param {Function} [onStep]    called with (placed, total) after each step
     * @returns {number[]} variable indices, most exogenous first
     */
    function directLingamOrder(cols, dirAdj, onStep) {
        var p = cols.length;
        var work = cols.map(function (c) { return c.slice(); });
        var U = [], order = [];
        for (var i = 0; i < p; i++) U.push(i);

        while (U.length > 0) {
            // Prior knowledge: a variable cannot be the next root while one of
            // its PC-established parents is still unplaced.
            var candidates = U.filter(function (i) {
                return !U.some(function (j) { return j !== i && dirAdj[j][i]; });
            });
            if (candidates.length === 0) candidates = U;   // shouldn't happen: PC's directed part is acyclic

            var root = searchCausalOrder(work, U, candidates);
            order.push(root);
            U = U.filter(function (i) { return i !== root; });

            if (U.length > 1) {
                // Regress the chosen root out of everything that is left.
                var rs = standardize(work[root]);
                if (rs) {
                    U.forEach(function (i) {
                        var xs = standardize(work[i]);
                        if (!xs) return;
                        var res = residualStd(xs, rs);
                        if (res) work[i] = res;
                    });
                }
            }
            if (onStep) onStep(order.length, p);
        }
        return order;
    }

    /** Is `to` reachable from `from` along directed edges? */
    function reachable(dirAdj, from, to, p) {
        if (from === to) return true;
        var seen = new Array(p).fill(false);
        var stack = [from];
        seen[from] = true;
        while (stack.length) {
            var v = stack.pop();
            for (var w = 0; w < p; w++) {
                if (dirAdj[v][w] && !seen[w]) {
                    if (w === to) return true;
                    seen[w] = true;
                    stack.push(w);
                }
            }
        }
        return false;
    }

    /**
     * Orient the edges PC left undirected using a DirectLiNGAM causal order,
     * in place. Modifies `result.adj` / `result.dirAdj` and records the
     * estimated order on `result.causalOrder`.
     *
     * Each edge is oriented to agree with the causal order; if that would close
     * a cycle against an orientation PC already fixed, the reverse is tried, and
     * if neither is safe the edge stays undirected (rendered as ↔). The output
     * is therefore always a DAG.
     */
    function applyLiNGAM(result, data, vars, onStep) {
        var adj = result.adj, dirAdj = result.dirAdj, p = vars.length;

        var pending = [];
        for (var i = 0; i < p; i++)
            for (var j = i + 1; j < p; j++)
                if (adj[i][j]) pending.push([i, j]);

        var cols = vars.map(function (v) {
            return data.map(function (row) { return row[v]; });
        });

        var order = directLingamOrder(cols, dirAdj, onStep);
        result.causalOrder = order.map(function (i) { return vars[i]; });

        var rank = new Array(p);
        order.forEach(function (v, k) { rank[v] = k; });
        result.rank = rank;

        pending.forEach(function (e) {
            var a = e[0], b = e[1];
            var from = rank[a] <= rank[b] ? a : b;
            var to   = from === a ? b : a;
            if (!reachable(dirAdj, to, from, p)) {
                adj[a][b] = adj[b][a] = false;
                dirAdj[from][to] = true;
            } else if (!reachable(dirAdj, from, to, p)) {
                adj[a][b] = adj[b][a] = false;
                dirAdj[to][from] = true;
            }
            // else: either direction closes a cycle — leave it undirected.
        });
    }

    // ── Acyclicity repair ─────────────────────────────────────────────────────
    //
    // PC's orientation rules assume a perfect conditional-independence oracle.
    // On real (finite) samples the recovered skeleton contains mistakes, and the
    // v-structure + Meek passes can then commit to a set of directions that
    // contains a directed cycle. A cyclic model is a dead end for the user:
    // DAGitty answers "Can't determine causal effects for cyclic models" and no
    // analysis panel works. So repair the orientation before emitting it.

    /** Find one directed cycle as a list of [from,to] edges, or null. */
    function findDirectedCycle(dirAdj, p) {
        var colour = new Array(p).fill(0), parent = new Array(p).fill(-1), found = null;
        function visit(u) {
            colour[u] = 1;
            for (var v = 0; v < p; v++) {
                if (!dirAdj[u][v]) continue;
                if (colour[v] === 1) {                 // back edge closes v ⇝ u → v
                    var cyc = [[u, v]], x = u;
                    while (x !== v) { cyc.push([parent[x], x]); x = parent[x]; }
                    found = cyc;
                    return true;
                }
                if (colour[v] === 0) { parent[v] = u; if (visit(v)) return true; }
            }
            colour[u] = 2;
            return false;
        }
        for (var s = 0; s < p && !found; s++) if (colour[s] === 0) visit(s);
        return found;
    }

    /**
     * Make the orientation acyclic, in place. For each cycle, the least
     * defensible edge is picked — the one that most contradicts the
     * DirectLiNGAM causal order, breaking ties by weakest marginal correlation
     * — and reversed if that is provably safe, otherwise downgraded to an
     * undirected (↔) edge. Each edge is downgraded at most once, so this
     * terminates.
     *
     * @returns {{reversed: number, relaxed: number}}
     */
    function enforceAcyclic(result) {
        var adj = result.adj, dirAdj = result.dirAdj, p = result.vars.length;
        var rank = result.rank, corr = result.corrMat;
        var reversed = 0, relaxed = 0, touched = {};
        var cyc;

        while ((cyc = findDirectedCycle(dirAdj, p))) {
            var pick = cyc[0], pickScore = -Infinity;
            cyc.forEach(function (e) {
                // Higher score = worse edge. Order violation dominates; the
                // weakest association breaks ties.
                var order = rank ? (rank[e[0]] - rank[e[1]]) : 0;
                var weak  = corr ? -Math.abs(corr[e[0]][e[1]]) : 0;
                var s = order * 1000 + weak;
                if (s > pickScore) { pickScore = s; pick = e; }
            });

            var u = pick[0], v = pick[1], key = u + ',' + v;
            dirAdj[u][v] = false;
            if (!touched[key] && !reachable(dirAdj, u, v, p)) {
                dirAdj[v][u] = true;                    // safe reversal
                touched[key] = true;
                reversed++;
            } else {
                adj[u][v] = adj[v][u] = true;           // give up on a direction
                relaxed++;
            }
        }
        return { reversed: reversed, relaxed: relaxed };
    }

    /** Plain-language note about what the acyclicity repair had to change. */
    function repairWarning(r) {
        var parts = [];
        if (r.reversed) parts.push(r.reversed + ' arrow' + (r.reversed !== 1 ? 's were' : ' was') + ' reversed');
        if (r.relaxed)  parts.push(r.relaxed  + ' arrow' + (r.relaxed  !== 1 ? 's were' : ' was') + ' left undirected (↔)');
        return 'The algorithm produced a circular chain of arrows, which cannot be a DAG; ' +
               parts.join(' and ') + ' to resolve it. Check those relationships against your ' +
               'domain knowledge — they are the least certain part of this diagram.';
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
     * Full pipeline: parse CSV → PC algorithm → optional DirectLiNGAM → DAGitty code.
     *
     * @param {string}  csvText   Raw CSV text
     * @param {number}  alpha     Significance level (default 0.05)
     * @param {boolean} useLingam Whether to apply DirectLiNGAM orientation (default true)
     * @returns {{ modelCode, nodeCount, edgeCount, undirectedCount, causalOrder, warnings, n }}
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

        // Repair before orienting, so DirectLiNGAM starts from an acyclic base…
        var repair = enforceAcyclic(result);

        if (useLingam) {
            applyLiNGAM(result, data, headers);
            // …and again afterwards, so the emitted model is always a DAG.
            var r2 = enforceAcyclic(result);
            repair.reversed += r2.reversed;
            repair.relaxed  += r2.relaxed;

            // Check if DirectLiNGAM was able to orient all edges
            var leftUndir = 0;
            for (var i = 0; i < headers.length; i++)
                for (var j = i+1; j < headers.length; j++)
                    if (result.adj[i][j]) leftUndir++;
            if (leftUndir > 0) warnings.push(leftUndir + ' edge(s) could not be oriented — shown as bidirected (<->).');
        }
        if (repair.reversed + repair.relaxed > 0)
            warnings.push(repairWarning(repair));

        var counts = countEdges(result);
        var modelCode = toModelCode(result, headers);

        return {
            modelCode: modelCode,
            nodeCount: headers.length,
            edgeCount: counts.directed + counts.undirected,
            directedCount: counts.directed,
            undirectedCount: counts.undirected,
            causalOrder: result.causalOrder || null,
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

            // Repair before orienting, so DirectLiNGAM starts from an acyclic base.
            var repair = enforceAcyclic(result);

            // Step 3 — DirectLiNGAM orientation. The causal-order search is
            // O(p³·n), so report progress as each variable is placed.
            if (useLingam) {
                prog(80, 'Estimating causal order (DirectLiNGAM)…');
                applyLiNGAM(result, data, headers, function (placed, total) {
                    prog(80 + Math.round(15 * placed / total),
                         'Estimating causal order (DirectLiNGAM) — ' + placed + '/' + total + '…');
                });
                // …and again afterwards, so the emitted model is always a DAG.
                var r2 = enforceAcyclic(result);
                repair.reversed += r2.reversed;
                repair.relaxed  += r2.relaxed;

                var leftUndir = 0;
                for (var i = 0; i < headers.length; i++)
                    for (var j = i + 1; j < headers.length; j++)
                        if (result.adj[i][j]) leftUndir++;
                if (leftUndir > 0)
                    warnings.push(leftUndir +
                        ' edge(s) could not be oriented — shown as bidirected (↔).');
            }
            if (repair.reversed + repair.relaxed > 0)
                warnings.push(repairWarning(repair));

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
                causalOrder:    result.causalOrder || null,
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
        directLingamOrder:    directLingamOrder,
        entropyApprox:        entropyApprox,
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
