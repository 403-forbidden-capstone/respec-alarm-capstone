#!/usr/bin/env bash
# Retired: EC2 runtime-mounted model artifacts are incompatible with Cloud Run
# source builds. Do not create billable GCP resources using an empty image.
set -euo pipefail
printf '%s\n' 'Cloud Run source deploy disabled: model artifacts are no longer bundled in the Docker image.' >&2
printf '%s\n' 'Use EC2 deployment in #471/#472 and services/prepare-ml/README.md.' >&2
printf '%s\n' 'A future Cloud Run deployment requires a separate secure model-artifact provisioning design.' >&2
exit 2
