"""Write the OpenAPI document: ``python -m oracle.openapi [path]`` (default: stdout)."""

import json
import sys

from oracle.main import app


def main() -> None:
    doc = json.dumps(app.openapi(), indent=2, sort_keys=False) + "\n"
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as f:
            f.write(doc)
    else:
        sys.stdout.write(doc)


if __name__ == "__main__":
    main()
