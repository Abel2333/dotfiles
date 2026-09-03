---
name: pdf-tools
description: Use when handling PDF files or documents: extracting text or
  embedded images, rendering pages to images, merging, splitting, converting,
  checking, OCR. Provides the tool priority chain, the pdf-tools uv
  environment, the mise-managed CLI project, and verified system CLI recipes.
---

# PDF Tools

Prefer existing tooling; do not hand-implement PDF parsing when the
libraries and CLIs below cover the need. Use this priority chain;
re-check availability per session (`command -v`, `mise ls-remote`)
because tools differ per machine:

1. pdf-tools uv environment (~/Tools/pyenvs/pdf-tools; deps: pymupdf,
   pypdf, pillow) for image extraction and page rendering.
2. mise-managed CLI project (~/Tools/mise/pdf/) for CLIs available in the
   mise registry (e.g. aqua:imagemagick).
3. System CLIs (qpdf, gs, magick, ffmpeg) for everything not provided
   above. qpdf and ghostscript are not in the mise registry.
4. If a needed tool is still missing, tell the user and ask before
   installing anything; never install system packages on your own.

## pdf-tools uv env

Extract embedded images and render pages:

    uv run --project ~/Tools/pyenvs/pdf-tools python \
      ~/Tools/pyenvs/pdf-tools/scripts/pdf_extract.py \
      images <file.pdf> [outdir]        # embedded images (default
                                        # outdir: ./extracted)
    uv run --project ~/Tools/pyenvs/pdf-tools python \
      ~/Tools/pyenvs/pdf-tools/scripts/pdf_extract.py \
      render <file.pdf> [outdir] [dpi]  # pages as PNG, default 300 dpi

For tiled/striped scans (a page made of many small JPEG tiles), use
`render` with high dpi (600-1200).

If the env does not exist on this machine: recreate it with
`uv init` + `uv add pillow pymupdf pypdf` plus the pdf_extract.py script,
or ask the user.

Note: pdf_extract.py currently has no `text` subcommand. When text
extraction is needed, propose extending the script with a pymupdf-based
`text` subcommand instead of writing ad-hoc code.

## mise-managed CLI project

Dedicated directory ~/Tools/mise/pdf/ with mise.toml pinning CLI tools
from the mise registry, e.g.:

    [tools]
    "aqua:imagemagick" = "latest"   # or pin a version, e.g. "7.1.2-30"

Run CLIs through the project so pinned versions apply:

    cd ~/Tools/mise/pdf && mise x -- magick -density 300 in.pdf out-%03d.png

- Register only tools that exist in the mise registry; check with
  `mise ls-remote aqua:<name>` before adding.
- Creation policy mirrors the uv convention: create the directory and
  mise.toml automatically on first need, tell the user what was created,
  do not ask permission first, do not create silently.
- Non-CLI package managers (npm, uv, cargo) work inside the same
  directory for language-specific dependencies.

## System CLI recipes (verified on qpdf 12.2, gs, magick, ffmpeg)

    qpdf --show-npages in.pdf               # page count
    qpdf --check in.pdf                     # integrity check
    qpdf --split-pages in.pdf out-%d.pdf            # one page per file
    qpdf --split-pages=2 in.pdf out-%d.pdf          # 2 pages per file
    qpdf --empty --pages a.pdf 1-3 b.pdf 4-6 -- out.pdf   # merge ranges
    qpdf --empty --pages in.pdf 2-5 -- out.pdf      # extract pages 2-5
    gs -sDEVICE=png16m -r300 -o page-%03d.png in.pdf     # render PNG
    magick -density 300 in.pdf out-%03d.png        # PDF to images

Note: gs numbers output files from 001, magick from 000.

## Guardrails

- Do not implement PDF parsing from scratch (xref tables, content streams,
  font maps, encryption) when a library or CLI covers the need; small
  scripts that call pymupdf/qpdf are not hand-rolling and are fine.
- Extending pdf_extract.py (e.g. a pymupdf-based `text` subcommand) is the
  preferred way to add a capability.
- If every existing tool fails on a file, or the task itself is about
  building a parser, state why existing tools are insufficient and ask the
  user before writing custom parsing code.
- Verify outputs: page count (qpdf --show-npages), image dimensions
  (magick identify or PIL).
- If a command would overwrite an input file, use a copy or confirm first.
- OCR is not covered by this chain: if OCR is needed, ask the user which
  tool to use before doing anything.
- Missing capability or new dependency: tell the user and ask before
  adding (never install system packages without confirmation).
