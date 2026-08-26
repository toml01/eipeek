# Chrome Web Store publishing

This runbook configures keyless, approval-gated publishing through the official
Chrome Web Store API v2. It does not use an OAuth client secret, refresh token,
service-account key, or generic publishing action.

## Current state

- Store item: `jeehadjadegokhcgmnnkdcenbpbolkll`
- Publisher: copy the ID from **Developer Dashboard → Publisher → Settings**
- Public store version: `0.2.1`
- Published GitHub release: `v0.3.0`
- Release ID: `375937330`
- Release asset: `eipeek-0.3.0-chrome.zip` (ID `528076253`, 151532 bytes)
- Asset SHA-256:
  `969ca245db8ea0410b11113b69fb5597f08c44ad04fefe151d84b9414a65de93`
- Annotated tag object: `baafbb0244419ff317d8a05cd1f824d33a87fa64`
- Tagged commit: `09815745f301ddf9e3c913f94959b2c873b2d876`

**No Chrome Web Store upload or submission has occurred yet.** Release `v0.3.0`
predates the workflow, so its rollout remains deliberate and manual: the `upload`
operation uploads the draft, then pauses while the Dashboard-only `alarms`
permission justification is saved. Only after that is saved may a separate
`submit` dispatch send the draft for review.

Chrome Dashboard service-account association is complete. A direct read-only
service-account `fetchStatus` check reported published version `0.2.1`, no
pending submission, no warning or takedown, and no recent upload.

The workflow pins the facts above because this legacy release is mutable. For
future versions, enable [GitHub immutable releases][github-immutable] before
publishing the release. Create a draft, attach the one correctly named ZIP, then
publish it. Future releases must use an annotated strict `vMAJOR.MINOR.PATCH` tag,
have GitHub's `immutable` flag set, and expose GitHub's asset SHA-256 digest. A
`release.published` event validates the release and then waits at the protected
environment; it never skips approval. The legacy `v0.3.0` release event is
explicitly rejected so unpublishing and republishing it cannot bypass its manual
typed confirmation.

## 1. Create the dedicated Google Cloud identity

The dedicated project and its federation are already configured. This is the
authoritative record; use the commands below to audit it, or recreate an individual
resource only if its audit shows that it is absent.

- Project ID: `eipeek-cws-publishing` (number `387257331685`)
- Service account: `eipeek-cws-publisher@eipeek-cws-publishing.iam.gserviceaccount.com`
- Workload Identity Pool: `eipeek-github`
- Provider: `eipeek-cws`
- Provider resource:
  `projects/387257331685/locations/global/workloadIdentityPools/eipeek-github/providers/eipeek-cws`

No billing account is currently linked. The required APIs are enabled without
billing, so no charge setup was needed. The setup creates no service-account JSON
key and grants the service account no Google Cloud project role.

In Cloud Shell, set the recorded values and audit the existing resources:

```sh
set -eu

PROJECT_ID='eipeek-cws-publishing'
PROJECT_NUMBER='387257331685'
POOL_ID='eipeek-github'
PROVIDER_ID='eipeek-cws'
SA_ID='eipeek-cws-publisher'
SUBJECT='repo:toml01@7473870/eipeek@1323913771:environment:chrome-web-store'
SA_EMAIL="${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)'
gcloud billing projects describe "${PROJECT_ID}"
gcloud services list --enabled --project="${PROJECT_ID}" \
  --filter='config.name:(chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com)' \
  --format='value(config.name)'
gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}"
gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project="${PROJECT_ID}" --location='global'
gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" --location='global' \
  --workload-identity-pool="${POOL_ID}"
gcloud iam service-accounts get-iam-policy "${SA_EMAIL}" \
  --project="${PROJECT_ID}"
```

If a resource above does not exist, recreate only that resource with the matching
command below. `gcloud services enable` is safe to rerun.

```sh
gcloud services enable \
  chromewebstore.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}"

gcloud iam service-accounts create "${SA_ID}" \
  --project="${PROJECT_ID}" \
  --display-name='EIPeek Chrome Web Store publisher'

gcloud iam workload-identity-pools create "${POOL_ID}" \
  --project="${PROJECT_ID}" \
  --location='global' \
  --display-name='EIPeek GitHub Actions'

gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location='global' \
  --workload-identity-pool="${POOL_ID}" \
  --display-name='EIPeek Chrome Web Store' \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id' \
  --attribute-condition="assertion.repository_owner_id == '7473870' && assertion.repository_id == '1323913771' && assertion.sub == '${SUBJECT}'"

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role='roles/iam.workloadIdentityUser' \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/1323913771" \
  --condition=None

printf 'GCP_WORKLOAD_IDENTITY_PROVIDER=projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\n' \
  "${PROJECT_NUMBER}" "${POOL_ID}" "${PROVIDER_ID}"
printf 'GCP_SERVICE_ACCOUNT=%s\n' "${SA_EMAIL}"
```

The provider mapping is
`google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id`.
Its condition checks both immutable numeric claims—repository `1323913771` and
owner `7473870`—and the exact environment subject:

```text
repo:toml01@7473870/eipeek@1323913771:environment:chrome-web-store
```

Do not broaden the condition to a repository name alone. Do not create or download
a service-account key. The only IAM grant is
`roles/iam.workloadIdentityUser` **on this service account** for the
repository-ID `principalSet`; the provider condition supplies the exact environment
restriction. The service account itself needs no Google Cloud project role.
These audits should return no user-managed key and no project-level role for it:

```sh
gcloud iam service-accounts keys list \
  --project="${PROJECT_ID}" --iam-account="${SA_EMAIL}" --managed-by=user
gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter="bindings.members=serviceAccount:${SA_EMAIL}" \
  --format='table(bindings.role)'
```

The service account has been added in **Chrome Web Store Developer Dashboard →
Account** as the publisher's allowed service account. Chrome currently allows one
service account per publisher. This association—not a Cloud project role—authorizes
access to the publisher's items. The publisher identifier is a non-secret resource
identifier; access tokens and credentials remain secret and must never be logged.

## 2. Protect the GitHub environment

The `chrome-web-store` environment is configured in repository settings:

1. Required reviewer: **@toml01**.
2. “Prevent self-review” is disabled. This repository has only one
   collaborator, so enabling it would make every deployment impossible.
3. Administrator bypass (“Allow administrators to bypass configured protection
   rules”) is disabled.
4. Deployment policies allow branch `main` and tags `v*`. Manual preflight runs
   should be started from `main`.

The only reviewer and the workflow initiator may therefore be the same person.
GitHub's approval is still an explicit, audited pause, but it is not independent
two-person approval. Add another trusted collaborator and enable prevent-self-review
if independent approval becomes possible.

All four **environment variables** are configured; they are not secrets:

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | Copy the publisher ID from **Developer Dashboard → Publisher → Settings** into this variable |
| `CWS_EXTENSION_ID` | `jeehadjadegokhcgmnnkdcenbpbolkll` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/387257331685/locations/global/workloadIdentityPools/eipeek-github/providers/eipeek-cws` |
| `GCP_SERVICE_ACCOUNT` | `eipeek-cws-publisher@eipeek-cws-publishing.iam.gserviceaccount.com` |

There are no GitHub secrets. The workflow requests a short-lived access token only
after the environment gate. Read-only status uses the
`chromewebstore.readonly` scope; upload, submission, and future combined publishing
use `chromewebstore`. Every mutation job needs only `contents: read` and
`id-token: write`; none of them write repository issues or read Actions history.

## 3. Preflight and release `v0.3.0`

From **Actions → Chrome Web Store → Run workflow**, use the `main` branch. Manual
`status`, `upload`, and `submit` jobs enforce `refs/heads/main`; manual `validate`
may run from another ref because it receives no Google credentials and cannot
mutate Chrome.

1. Read-only status preflight: set tag `v0.3.0`, operation `status`, and leave
   confirmation empty. Approve the environment wait. This calls only API v2
   `fetchStatus`; it cannot upload or publish. Confirm that the report agrees with
   the Developer Dashboard and has no warning, takedown, active submission, or
   recent upload. `fetchStatus` cannot identify unsubmitted draft bytes.
2. Artifact preflight: set tag `v0.3.0`, operation `validate`, and leave
   confirmation empty. This needs neither Google authentication nor environment
   approval. It verifies GitHub IDs and pins, ZIP digest, root manifest, package
   version, MV3, name, exact permissions, and absence of optional privilege
   fields. It checks out the resolved release commit without persisted credentials,
   installs and builds it under Node 22 without CWS or Google credentials, and
   requires the normalized ZIP file tree and every file byte to equal that build.
3. Upload the draft:

   ```sh
   gh workflow run chrome-web-store.yml --ref main \
     -f release_tag=v0.3.0 \
     -f operation=upload \
     -f confirmation='upload draft v0.3.0 only'
   ```

   Approve this run's `chrome-web-store` environment wait. The `upload` job
   re-downloads the artifact, revalidates every approved release identity and byte
   digest, authenticates with WIF, and plans the mutation from a fresh, read-only
   `fetchStatus` read. If that plan already shows the target draft or version in
   place, the job is a safe no-op; otherwise it calls the API v2 media-upload
   endpoint once and requires a direct synchronous `SUCCEEDED` response for
   `v0.3.0`. It never calls publish.
4. In the Chrome Web Store Developer Dashboard, open the visible `0.3.0` draft.
   Compare the **detailed description** and confirm it is unchanged. Save **only**
   the new `alarms` permission justification; do not change listing metadata,
   release assets, distribution, or any other field. Obtain explicit second
   approval to submit after that saved Dashboard state has been reviewed.
5. Submit the reviewed draft:

   ```sh
   gh workflow run chrome-web-store.yml --ref main \
     -f release_tag=v0.3.0 \
     -f operation=submit \
     -f confirmation='submit v0.3.0 after saving alarms justification'
   ```

   Approve this separate run's `chrome-web-store` environment wait. The typed
   confirmation and this second approval are the human attestation that Dashboard
   draft `0.3.0` was visible, its detailed description remained unchanged, and the
   `alarms` justification was saved. The `submit` job revalidates release
   provenance again, plans the mutation from a fresh `fetchStatus` read, and — if
   not already pending or published — calls only API v2 publish with:

   ```json
   {"publishType":"DEFAULT_PUBLISH","skipReview":false,"blockOnWarnings":true}
   ```

That submission goes to Chrome review and **automatically becomes public when
Chrome approves it**. The workflow never cancels a submission and never blindly
retries an uncertain upload or publish POST. If exact `0.3.0` is already pending or
published, both `upload` and `submit` are read-only no-ops.

Manual combined publishing is unavailable. Manual `upload` and `submit` are
restricted to pinned legacy release `v0.3.0`, their exact confirmation, and `main`.
A `release.published` event for `v0.3.0` is excluded from the future publish job
and rejected during validation. Later releases retain the combined protected
upload-and-submit path only from their `release.published` event. Manual
`validate` and main-only `status` continue to support later tags.

For later versions, publishing a non-draft, non-prerelease GitHub release triggers
the same validation and queues the protected publish job automatically. Keep
release immutability enabled; prepare all assets before publishing the draft.

## Idempotency and recovery

- `upload`, `submit`, and the automatic `publish` job each start with a plan step
  that reads live Chrome Web Store status (`fetchStatus`) and decides the mutation
  from that alone — there is no separate audit record to consult or keep in sync.
  Calling `upload` again once the store already has the target draft, or `submit`
  again once it is already pending review or published, is always a safe no-op.
- Every error after an upload or publish request may have been sent is an unknown
  outcome. This includes a timeout or abort, network exception, non-2xx response,
  non-JSON success, or response identity/schema/version mismatch. Do not rerun
  the failed stage blindly. Run read-only `status` and inspect the Developer
  Dashboard. An exact pending or published version is a safe no-op; any other
  state requires manual resolution there.
- Resolve policy warnings, takedowns, rejected submissions, staged releases, or
  conflicting active submissions in the Dashboard. The automation fails closed
  and does not cancel anything.
- To stop new GitHub deployments immediately, disable the Workload Identity
  provider:

  ```sh
  gcloud iam workload-identity-pools providers update-oidc eipeek-cws \
    --project="${PROJECT_ID}" --location=global \
    --workload-identity-pool=eipeek-github --disabled
  ```

- Also remove the service-account email from Chrome Web Store Dashboard → Account.
  Existing access tokens are short-lived (at most the workflow's 20-minute token)
  and then expire.
- For permanent teardown, remove the `roles/iam.workloadIdentityUser` binding, then
  delete the provider/pool and service account. Verify the exact IAM policy first;
  do not copy a destructive command without checking its project and principal.

## Official references

- [Chrome Web Store API v2 overview][cws-api]
- [Service-account authorization][cws-service-account]
- [`fetchStatus`][cws-status], [media upload][cws-upload], and [publish][cws-publish]
- [Google Workload Identity Federation for deployment pipelines][google-wif]
- [Google GitHub Actions authentication][google-auth]
- [GitHub immutable OIDC subject claims][github-oidc]
- [GitHub deployment environments][github-environments]
- [GitHub immutable releases][github-immutable]

[cws-api]: https://developer.chrome.com/docs/webstore/api/reference/rest
[cws-service-account]: https://developer.chrome.com/docs/webstore/service-accounts
[cws-status]: https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus
[cws-upload]: https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload
[cws-publish]: https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
[google-wif]: https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines#github-actions
[google-auth]: https://github.com/google-github-actions/auth
[github-oidc]: https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims
[github-environments]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[github-immutable]: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes
