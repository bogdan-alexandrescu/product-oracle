"""Engineering specs, user flows and low-fidelity wireframes from an approved PRD (CR-09).

- :mod:`oracle.specs.contract`: the spec's sections, which part each belongs to (product
  requirement, proposed engineering approach, open decision, assumption, context), and
  how Oracle composes a spec version from an agent's draft.
- :mod:`oracle.specs.sanitize`: the allowlist sanitiser for SVG flows and HTML
  wireframes (static, no scripts, no network).
- :mod:`oracle.specs.design`: ``design.json`` checks (names, sizes, types, links).
- :mod:`oracle.specs.lineage`: artifact versions, provenance and dependencies for every
  spec version, flow and wireframe (``oracle.changes`` handler ``specs.lineage``).
- :mod:`oracle.specs.service`, :mod:`oracle.specs.router`: the ``/v1/spec-requests`` and
  ``/v1/design-artifacts`` routes.

The run that writes them is the code-defined flow ``prd_to_spec`` (``oracle.runs.flows``).
"""
