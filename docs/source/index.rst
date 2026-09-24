Viser
=====

|pyright| |nbsp| |typescript| |nbsp| |versions| |discord|

Viser is a 3D visualization library for computer vision and robotics in Python.

Features include:

- API for visualizing 3D primitives
- GUI building blocks: buttons, checkboxes, text inputs, sliders, etc.
- Scene interaction tools (clicks, selection, transform gizmos)
- Programmatic camera control and rendering
- An entirely web-based client, for easy use over SSH!
- Jupyter notebook compatibility

The goal is to provide primitives that are (1) easy for simple visualization tasks, but (2) can be composed into more elaborate interfaces. For more about design goals, see the `technical report <https://arxiv.org/abs/2507.22885>`_.

Install with:

.. code-block:: bash

   pip install viser

Demo reel:

.. raw:: html

   <video src="https://brentyi.github.io/viser-example-assets/viser_demos.mp4" controls playsinline width="100%"></video><section id="examples">

To cite Viser, you can use the BibTeX entry for our `RSS 2026 paper <https://doi.org/10.15607/RSS.2026.XXII.175>`_ (`arXiv <https://arxiv.org/abs/2507.22885>`_):

.. code:: bibtex

    @INPROCEEDINGS{yi2026viser,
        AUTHOR    = {Brent Yi AND Chung Min Kim AND Justin Kerr AND Gina Wu AND Rebecca Feng AND Anthony Zhang AND Jonas Kulhanek AND Hongsuk Choi AND Yi Ma AND Matthew Tancik AND Angjoo Kanazawa},
        TITLE     = {{Viser: Imperative, Web-based 3D Visualization for Python}},
        BOOKTITLE = {Proceedings of Robotics: Science and Systems},
        YEAR      = {2026},
        ADDRESS   = {Sydney, Australia},
        MONTH     = {July},
        DOI       = {10.15607/RSS.2026.XXII.175}
    }

Examples
--------

Install with: ``pip install viser[examples]``


.. include:: examples/_example_gallery.rst


.. toctree::
   :caption: Examples
   :hidden:
   :maxdepth: 1
   :titlesonly:

   examples/getting_started/index
   examples/scene/index
   examples/gui/index
   examples/interaction/index
   examples/demos/index

.. toctree::
   :caption: API Reference
   :hidden:
   :maxdepth: 1
   :titlesonly:

   api/core/index
   api/handles/index
   api/advanced/index
   api/auxiliary/index

.. toctree::
   :caption: Notes
   :hidden:
   :maxdepth: 1
   :titlesonly:

   ./interactive_notebooks.ipynb
   ./conventions.rst
   ./performance_tips.rst
   ./development.rst
   ./embedded_visualizations.rst
   ./citation.rst

.. |pyright| image:: https://github.com/viser-project/viser/actions/workflows/pyright.yml/badge.svg
   :alt: Pyright status icon
   :target: https://github.com/viser-project/viser
.. |typescript| image:: https://github.com/viser-project/viser/actions/workflows/typescript-compile.yml/badge.svg
   :alt: TypeScript status icon
   :target: https://github.com/viser-project/viser
.. |versions| image:: https://img.shields.io/pypi/pyversions/viser
   :alt: Version icon
   :target: https://pypi.org/project/viser/
.. |nbsp| unicode:: 0xA0
   :trim:
.. |discord| image:: https://img.shields.io/discord/1423204924518432809?logo=discord&label=discord
   :alt: Discord icon
   :target: https://discord.gg/pnNTkHNUwP
