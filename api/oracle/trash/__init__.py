"""Trash (#482): deleted documents, intakes and runs wait here for 30 days.

- :mod:`oracle.trash.models`: the ``deleted_*`` columns (:class:`Trashable`) and one
  :class:`TrashEntry` per delete (the root and what went with it);
- :mod:`oracle.trash.filter`: every ORM read leaves trashed rows (and what hangs off
  them) out, as the tenant scope is added;
- :mod:`oracle.trash.service`: the dependents resolver, delete, restore and the purge;
- :mod:`oracle.trash.regenerate`: Regenerate, a new run that imports the next version.
"""
