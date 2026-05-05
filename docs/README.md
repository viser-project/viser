# Viser Documentation

This directory contains the documentation for Viser.

## Building the Documentation

To build the documentation:

1. Install the documentation dependencies:

   ```bash
   pip install -r docs/requirements.txt
   ```

2. Build the documentation:

   ```bash
   cd docs
   make html
   ```

3. View the documentation:

   ```bash
   # On macOS
   open build/html/index.html

   # On Linux
   xdg-open build/html/index.html
   ```

## Contributing Screenshots

When adding new documentation, screenshots and visual examples significantly improve user understanding.

We need screenshots for:

- The Getting Started guide
- GUI element examples
- Scene API visualization examples
- Customization/theming examples

See [Contributing Visuals](./source/contributing_visuals.md) for guidelines on capturing and adding images to the documentation.

## Documentation Structure

- `source/` - Source files for the documentation
  - `_static/` - Static files (CSS, images, etc.)
    - `images/` - Screenshots and other images
  - `examples/` - Example code with documentation
  - `*.md` - Markdown files for documentation pages
  - `conf.py` - Sphinx configuration

## Auto-Generated Example Documentation

Example documentation is automatically generated from the examples in the `examples/` directory using the `update_example_docs.py` script. To update the example documentation after making changes to examples:

```bash
cd docs
python update_example_docs.py
```
