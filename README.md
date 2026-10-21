# PyFeat Web

FastAPI experiment web app for the PyFeat demo.

Python dependencies are pinned with hashes in `requirements.txt`. After updating
the direct versions in `requirements.in`, regenerate the cross-platform lock with:

```sh
uv pip compile requirements.in --upgrade --python-version 3.13 --universal --generate-hashes --no-header --no-annotate --output-file requirements.txt --index-url https://pypi.org/simple
```

CI audits both dependency trees and checks application compatibility before the
existing push-to-master deployment. The Windows deploy upgrades to the audited
Python lock and stops on an installation or compatibility failure.
