"""Traceability and staleness (CR-05, build prompt §7 and §11.5).

One authoritative baseline graph (``oracle.baseline``) carries the chain *evidence →
goal → outcome → feature → requirement → acceptance criterion*; the foundation's
revision-aware link tables carry the rest: *→ document section* (``document_section_links``)
*→ derived artifact or roadmap item* (``artifact_dependencies``). This package reads them
together and never duplicates graph entities:

- :mod:`oracle.trace.graph`: walks the graph up (towards goals) and down (towards
  requirements, acceptance criteria and whatever an assumption, blocker, decision or
  risk affects);
- :mod:`oracle.trace.staleness`: the ``trace.mark_stale`` change handler and the
  human review/reconcile actions;
- :mod:`oracle.trace.impact`: the impact explorer and its targeted regeneration plan;
- :mod:`oracle.trace.evidence`: the evidence inspector and the appendix's evidence
  links (rendered bodies stay free of citations, O1c);
- :mod:`oracle.trace.views`: the version and baseline-node traces.

See docs/product-oracle-v2/05-artifact-contracts.md.
"""
