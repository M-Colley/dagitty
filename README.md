# DAGitty — accessibility-focused fork

> A beginner-friendly version of the [DAGitty](https://dagitty.net) causal-diagram editor.
>
> **▶ Try it live (free, no install): https://m-colley.github.io/dagitty/**

![A walkthrough of the redesigned DAGitty: loading a worked HCI example, accidentally controlling for a mediator and the Diagram check naming the variable and explaining why that is wrong, the one-click "Assumptions for your paper" statement, the publication-figure export, suggesting a diagram from a data file with PC + DirectLiNGAM, copying a shareable link, and the dark theme.](assets/demo.gif)

This fork reworks the DAGitty browser GUI to make building and documenting causal diagrams (DAGs)
approachable for people new to causal inference, while keeping all of the original analysis power.

**What's new in the GUI**

- 🎨 Modern, responsive redesign with automatic light/dark mode
- 🧭 **Interactive guided tutorial** for first-time users (*Help → Interactive tutorial*, and a one-time prompt on first visit)
- 📝 **"Assumptions for your paper"** — a one-click, plain-language statement of the (often untestable) assumptions your diagram requires to read a result as causal, ready to paste into a methods or limitations section
- 💬 Plain-language analysis output (e.g. *“Your chosen controls block all confounding”* instead of *“Correctly adjusted”*)
- 🩺 **Diagram check** — names the specific mistake and the variable involved (*“M sits on a causal pathway
  from X to Y — controlling for it removes part of the effect you are trying to measure”*): mediators,
  colliders, arrows drawn the wrong way round, sample selection on a common effect
- 🧰 Beginner / Advanced mode, undo / redo, empty-canvas hints, and inline help on every concept
- 💾 **Never lose work** — the diagram is saved in your browser and restored on the next visit;
  open a saved `.dag` file from the Model menu or by dragging it onto the page
- 🔗 **Copy shareable link** — the whole diagram travels inside the URL, so a collaborator opening it
  sees exactly your model. Nothing is uploaded anywhere
- 📂 Machine-readable model code plus PNG / JPEG / SVG / LaTeX / R (dagitty + ggdag) export
- 🔬 Optional **Generate DAG from data** — in-browser causal discovery with the PC algorithm plus
  [DirectLiNGAM](https://www.jmlr.org/papers/v12/shimizu11a.html) (a port of
  [`lingam.DirectLiNGAM`](https://github.com/cdt15/lingam) v1.13.0); the suggested model is always a DAG

The diagram editing and analysis engine is the original DAGitty by Johannes Textor & Benito van der Zander
(GNU GPL v2). The full upstream project description follows.

The live site is published automatically from [`gui/`](gui) via GitHub Pages on every push to `master`
(see [`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

---

# dagitty

This is a collection of algorithms, a GUI frontend and an R package for analyzing
graphical causal models (DAGs).

The main components of the repository are:

 * [jslib](jslib): a JavaScript library implementing many DAG algorithms. This library underpins
 both the web interface and the R package, but could also be used independently, like in node.js.
 * [gui](gui): HTML interface for a GUI that exposes most of the functions in the JavaScript library.
 * [r](r): R package that exposes most of the functions in the JavaScript library.
 * [website](website): The current content of [dagitty.net](https://dagitty.net), including a version of the GUI (which may be older than the one in [gui](gui). 
 * [doc](doc): LaTeX source of the dagitty PDF documentation.

## Running the web interface locally

Clone the repository and open the file `gui/dags.html` in your web browser.
Currently most functionality should work locally, but you will need an internet
connection if you want to load or save DAG models on [dagitty.net](https://dagitty.net).

## Running the R package

The R package can be installed from CRAN, but this version is not updated very
frequently. If you want to install the most recent version of the dagitty R package,
you can:

```
install.packages("remotes") # unless you have it already
remotes::install_github("jtextor/dagitty/r")
```

If you encounter any problems installing the R package,
it is probably not due to dagitty itself, but due to the
package "V8" that it depends on. 
I may try to remove this dependency in a future version.

# More information

You can get more information on dagitty at [dagitty.net](https://dagitty.net) and
 [dagitty.net/learn](https://dagitty.net/learn). The R package is
documented through the standard R help interface.
There are also a few papers available:

1. Textor, J., van der Zander, B., Gilthorpe, M. S., Liśkiewicz, M., & Ellison, G. T. H. (2017). Robust causal inference using directed acyclic graphs: the R package ‘dagitty.’ In International Journal of Epidemiology (p. dyw341). Oxford University Press (OUP). https://doi.org/10.1093/ije/dyw341

2. Ankan, A., Wortel, I. M. N., & Textor, J. (2021). Testing Graphical Causal Models Using the R Package “dagitty.” In Current Protocols (Vol. 1, Issue 2). Wiley. https://doi.org/10.1002/cpz1.45


 
