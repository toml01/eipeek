# Chrome Web Store publishing

This runbook configures keyless, approval-gated publishing through the official
Chrome Web Store API v2. It does not use an OAuth client secret, refresh token,
service-account key, or generic publishing action.

## Current state

- Store item: `jeehadjadegokhcgmnnkdcenbpbolkll`
- Publisher: `42f46ef0-44f9-444b-a0f7-7d5d80bd336b`
- Public store version: `0.2.1`
- Published GitHub release: `v0.3.0`
- Release ID: `375937330`
- Release asset: `eipeek-0.3.0-chrome.zip` (ID `528076253`, 151532 bytes)
- Asset SHA-256:
  `969ca245db8ea0410b11113b69fb5597f08c44ad04fefe151d84b9414a65de93`
- Annotated tag object: `baafbb0244419ff317d8a05cd1f824d33a87fa64`
- Tagged commit: `09815745f301ddf9e3c913f94959b2c873b2d876`

**Nothing has been uploaded or submitted by this automation.** Release `v0.3.0`
predates the workflow, so it can run only through a deliberate manual dispatch.
Do not select `publish` until the upload and automatic-after-review release have
been explicitly approved.

The workflow pins all facts above because this legacy release is mutable. For
future versions, enable [GitHub immutable releases][github-immutable] before
publishing the release. Create a draft, attach the one correctly named ZIP, then
publish it. Future releases must use an annotated strict `vMAJOR.MINOR.PATCH` tag
and expose GitHub's asset SHA-256 digest. A `release.published` event validates the
release and then waits at the protected environment; it never skips approval.

## 1. Create the dedicated Google Cloud identity

A dedicated Google Cloud project is recommended so its trust and audit trail are
isolated. No paid usage is expected from Workload Identity Federation, IAM, or the
Chrome Web Store API. Google setup documentation can nevertheless require billing
to be enabled: a billing account and payment method might have to be linked even
though these APIs have no expected usage charge.

In the Cloud console, create or select that project and open Cloud Shell. Replace
only `PROJECT_ID` below. The commands create no service-account JSON key and grant
the service account no project role.

```sh
set -eu

PROJECT_ID='REPLACE_WITH_DEDICATED_PROJECT_ID'
POOL_ID='eipeek-github'
PROVIDER_ID='eipeek-cws'
SA_ID='eipeek-cws-publisher'
SUBJECT='repo:toml01@7473870/eipeek@1323913771:environment:chrome-web-store'

gcloud services enable \
  chromewebstore.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" \
  --format='value(projectNumber)')"
SA_EMAIL="${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

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
  --attribute-condition="attribute.repository_owner_id == '7473870' && attribute.repository_id == '1323913771' && google.subject == '${SUBJECT}'"

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role='roles/iam.workloadIdentityUser' \
  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/${SUBJECT}" \
  --condition=None

printf 'GCP_WORKLOAD_IDENTITY_PROVIDER=projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\n' \
  "${PROJECT_NUMBER}" "${POOL_ID}" "${PROVIDER_ID}"
printf 'GCP_SERVICE_ACCOUNT=%s\n' "${SA_EMAIL}"
```

The condition checks both immutable numeric claims—repository `1323913771` and
owner `7473870`—and the exact post-July-15-2026 environment subject:

```text
repo:toml01@7473870/eipeek@1323913771:environment:chrome-web-store
```

Do not broaden the condition to a repository name alone. Do not create or download
a service-account key. The only IAM grant is
`roles/iam.workloadIdentityUser` **on this service account** for the exact
federated subject; the service account itself needs no Google Cloud project role.
These audits should return no user-managed key and no project-level role for it:

```sh
gcloud iam service-accounts keys list \
  --project="${PROJECT_ID}" --iam-account="${SA_EMAIL}" --managed-by=user
gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter="bindings.members=serviceAccount:${SA_EMAIL}" \
  --format='table(bindings.role)'
```

In **Chrome Web Store Developer Dashboard → Account**, add `SA_EMAIL` as the
publisher's allowed service account. Chrome currently allows one service account
per publisher. This association—not a Cloud project role—authorizes access to the
publisher's items.

## 2. Protect the GitHub environment

Create an environment named exactly `chrome-web-store` in repository settings.

1. Add required reviewer **@toml01**.
2. Do **not** enable “Prevent self-review.” This repository has only one
   collaborator, so enabling it would make every deployment impossible.
3. Disable administrator bypass (“Allow administrators to bypass configured
   protection rules”) if that control is available.
4. Restrict deployment branches/tags to `main` and version tags (`v*`) as needed.
   Manual preflight runs should be started from `main`.

The only reviewer and the workflow initiator may therefore be the same person.
GitHub's approval is still an explicit, audited pause, but it is not independent
two-person approval. Add another trusted collaborator and enable prevent-self-review
if independent approval becomes possible.

Add these **environment variables**, not secrets:

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | `42f46ef0-44f9-444b-a0f7-7d5d80bd336b` |
| `CWS_EXTENSION_ID` | `jeehadjadegokhcgmnnkdcenbpbolkll` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/eipeek-github/providers/eipeek-cws` |
| `GCP_SERVICE_ACCOUNT` | `eipeek-cws-publisher@PROJECT_ID.iam.gserviceaccount.com` |

There are no GitHub secrets. The workflow requests a short-lived access token only
after the environment gate. Read-only status uses the
`chromewebstore.readonly` scope; publishing uses `chromewebstore`.

## 3. Preflight and release `v0.3.0`

From **Actions → Chrome Web Store → Run workflow**, use the `main` branch.

1. Read-only preflight: set tag `v0.3.0`, operation `status`, and leave
   confirmation empty. Approve the environment wait. This calls only API v2
   `fetchStatus`; it cannot upload or publish. Confirm that the report says public
   version `0.2.1`, with no warning, takedown, active submission, or ambiguous
   recent upload.
2. Artifact preflight: set tag `v0.3.0`, operation `validate`, and leave
   confirmation empty. This needs neither Google authentication nor environment
   approval. It verifies GitHub IDs and pins, ZIP digest, root manifest, package
   version, MV3, name, and exact permissions.
3. **Stop here until explicit approval to publish has been given.**
4. Later, set tag `v0.3.0`, operation `publish`, and confirmation exactly
   `publish v0.3.0`. Then approve the `chrome-web-store` environment wait.

Approval performs the single public-release gate. After approval, the job downloads
the validated asset again by asset ID, rechecks all identities and SHA-256, checks
store state, uploads once, and submits once with:

```json
{"publishType":"DEFAULT_PUBLISH","skipReview":false,"blockOnWarnings":true}
```

That submission goes to Chrome review and **automatically becomes public when
Chrome approves it**. There is no second manual gate. The workflow never cancels a
submission and never blindly retries an uncertain upload or publish POST. If the
exact version is already pending or published, it records a no-op instead.

For later versions, publishing a non-draft, non-prerelease GitHub release triggers
the same validation and queues the protected publish job automatically. Keep
release immutability enabled; prepare all assets before publishing the draft.

## Recovery and revocation

- If a mutating request reports a network failure, do not rerun `publish`
  immediately. Run the read-only `status` operation and inspect the Developer
  Dashboard. An exact pending or published version is a safe no-op; any conflicting
  or ambiguous state requires manual investigation.
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
