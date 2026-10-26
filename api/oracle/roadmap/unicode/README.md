Unicode's confusables.txt (UTS #39), version 15.0.0, the version Python 3.12's
`unicodedata` reports; from https://www.unicode.org/Public/security/15.0.0/confusables.txt,
unchanged. The leak check (`oracle/roadmap/leak_check.py`) matches names on the confusable
skeleton it defines. Licensed under the Unicode License v3 (LICENSE.txt). When Python's
Unicode version changes, replace the file with that version's (the test
`test_the_confusables_table_is_vendored_for_pythons_unicode_version` says so).
