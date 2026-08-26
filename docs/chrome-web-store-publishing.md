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

**No Chrome Web Store upload or submission has occurred.** Protected run
`32993251330`, at workflow SHA
`06095bccb8b2fe00756b1cf34704a0d063f03c94`, created canonical open
`eipeek-cws-upload-attempt/v1` issue #9. GitHub's immediate repository issue-list
scan did not expose the new issue even though both the create response and direct
issue GET had validated it. The ledger step therefore failed; the upload and
upload-success steps were conclusively skipped. Issue #9 is permanent and must
not be edited, closed, or deleted. The ordinary `upload` operation is now
intentionally blocked. The narrowly pinned, one-shot `resume-upload` operation
below is the only automated recovery for this ledger-only incident.

Release `v0.3.0` predates the workflow, so its rollout remains deliberate and
manual. A separately approved recovery would upload the draft, then pause while
the Dashboard-only `alarms` permission justification is saved. Only after explicit
second approval may a separate dispatch submit that draft for review.

Chrome Dashboard service-account association is complete. A direct read-only
service-account `fetchStatus` check is also complete: it reported published version
`0.2.1`, no pending submission, no warning or takedown, and no recent upload. The
failed protected run completed WIF authentication and read-only upload planning
before the ledger-only failure.
`fetchStatus` does not expose or cryptographically identify unsubmitted draft
bytes. An absent `lastAsyncUploadState` is therefore not proof that no draft
exists. The exact upload-attempt and synchronous-success issues, the Dashboard
inspection, the second typed confirmation, and the second environment approval
are all required before submission.

The workflow pins all facts above because this legacy release is mutable. For
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
use `chromewebstore`. Only mutation jobs receive `issues: write` for their durable
public ledgers. Only the protected upload job additionally receives `actions: read`,
and only so `resume-upload` can verify the pinned prior run and job. The status job
has only `contents: read` and `id-token: write`.

## 3. Preflight and release `v0.3.0`

From **Actions → Chrome Web Store → Run workflow**, use the `main` branch. Manual
`status`, `upload`, `resume-upload`, and `submit` jobs enforce `refs/heads/main`;
manual `validate` may run from another ref because it receives no Google
credentials and cannot mutate Chrome. Do not select ordinary `upload` for this
release again: permanent issue #9 makes that path fail closed.

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
3. The ordinary upload stage has already made its permanent pre-upload claim.
   Run `32993251330` failed only because issue #9 was not yet visible in the final
   repository list scan. Its CWS upload step 10 and success-ledger step 11 were
   skipped. Do not rerun that run and do not dispatch `operation=upload` again.
4. **Stop here.** First merge this recovery implementation to `main`, complete and
   review the read-only `status` and `validate` checks above from that merged
   revision, and obtain **fresh explicit approval after those checks** to use the
   one-shot recovery. Approval for the original failed upload run is not approval
   for recovery. Only then dispatch exactly once with:

   ```sh
   gh workflow run chrome-web-store.yml --ref main \
     -f release_tag=v0.3.0 \
     -f operation=resume-upload \
     -f confirmation='resume upload draft v0.3.0 after verified ledger-only failure'
   ```

   Approve this run's `chrome-web-store` environment wait. The operation is
   restricted to `v0.3.0`, `main`, `workflow_dispatch`, and run attempt 1. The
   confirmation is case-sensitive and whitespace-sensitive. The caller supplies
   no historical run, job, or issue ID.
5. After approval, the same protected upload job re-downloads the artifact,
   revalidates every approved release identity and byte digest, authenticates with
   WIF, and makes a read-only CWS plan. Recovery requires the plan action to be
   exactly `upload`. It derives the original run and issue only from the one
   canonical upload-attempt/v1 ledger and requires no resume, upload-success, or
   submit-attempt ledger.

   With `actions: read`, the helper checks the latest run record to exclude any
   later rerun, then checks exact run attempt 1, every paginated job-list page, and
   a matching direct job GET. Repository ID/name, run ID/attempt/URLs, workflow
   path, `main`, `workflow_dispatch`, completed/failure state, head SHA, and
   workflow SHA must match. The only reviewed contract is workflow SHA
   `06095bccb8b2fe00756b1cf34704a0d063f03c94`, job
   `Protected v0.3.0 draft upload`, and these exact critical steps:

   - step 9 `Create and verify canonical pre-upload attempt ledger`:
     `completed` / `failure`;
   - step 10 `Upload v0.3.0 draft without publishing`:
     `completed` / `skipped`;
   - step 11 `Create and verify canonical synchronous upload-success ledger`:
     `completed` / `skipped`.

   Missing, duplicate, renamed, reordered, null, in-progress, malformed, timed-out,
   or otherwise unknown Actions data blocks recovery. Logs are deliberately not
   downloaded: the pinned workflow bytes establish where CWS mutation could occur,
   and the exact skipped mutation step proves it did not occur.

   Only after this proof does the run create and stably list-verify one canonical
   `eipeek-cws-upload-resume-attempt/v1` issue. That issue links #9, identifies the
   current recovery run, and records the canonical prior run/job/step evidence.
   It is the one-shot pre-mutation claim. The next step calls only the existing API
   v2 media upload helper; it never calls publish. A linked
   `eipeek-cws-upload-success/v2` issue is created only for an exact synchronous
   response with the correct item ID/name, `uploadState: SUCCEEDED`, and
   `crxVersion: 0.3.0`.
6. In the Chrome Web Store Developer Dashboard, open the visible `0.3.0` draft.
   Compare the **detailed description** and confirm it is unchanged. Save **only**
   the new `alarms` permission justification; do not change listing metadata,
   release assets, distribution, or any other field. Obtain explicit second
   approval to submit after that saved Dashboard state has been reviewed.
7. Run the second stage with exactly:

   ```sh
   gh workflow run chrome-web-store.yml --ref main \
     -f release_tag=v0.3.0 \
     -f operation=submit \
     -f confirmation='submit v0.3.0 after saving alarms justification'
   ```

   Approve this separate run's `chrome-web-store` environment wait. The typed
   confirmation and this second approval are the human attestation that Dashboard
   draft `0.3.0` was visible, its detailed description remained unchanged, and the
   `alarms` justification was saved.

The submit run performs release and tagged-source provenance validation again,
then revalidates the release asset after approval. It scans open and closed issues
and accepts exactly one of two immutable chains: normal upload-attempt/v1 →
upload-success/v1, or recovery upload-attempt/v1 → upload-resume-attempt/v1 →
upload-success/v2. The existing submit-attempt/v1 links the original attempt and
the accepted success issue, so the recovery link remains transitive. Malformed,
duplicate, mismatched, mixed-version, or incorrectly linked records stop the run.
It then rechecks store state, creates and stably list-verifies a canonical
submit-attempt issue, rechecks state immediately before mutation, and calls only
API v2 publish with:

```json
{"publishType":"DEFAULT_PUBLISH","skipReview":false,"blockOnWarnings":true}
```

That submission goes to Chrome review and **automatically becomes public when
Chrome approves it**. The workflow never cancels a submission and never blindly
retries an uncertain upload or publish POST. If exact `0.3.0` is already pending or
published, submission is a read-only no-op after upload-ledger verification.

Manual combined publishing is unavailable. Manual `upload`, `resume-upload`, and
`submit` are restricted to pinned legacy release `v0.3.0`, their exact confirmation
where applicable, and `main`; recovery has the additional one-shot and run-attempt
1 restrictions. A `release.published` event for `v0.3.0` is excluded from the
future publish job and rejected during validation. Later releases retain the
combined protected upload-and-submit path only from their `release.published`
event. Manual `validate` and main-only `status` continue to support later tags.

For later versions, publishing a non-draft, non-prerelease GitHub release triggers
the same validation and queues the protected publish job automatically. Keep
release immutability enabled; prepare all assets before publishing the draft.

### Ledger list visibility and state machine

GitHub issue creation and repository issue-list reads can be briefly inconsistent.
For every newly created staged ledger—upload attempt, normal or recovered upload
success, recovery resume, and submit attempt—the helper first validates the POST
response and an exact direct issue GET. Those direct responses prove only the
created object's identity; they are never inserted into or substituted for a
repository scan.

The helper then polls the complete open-and-closed issue list, following every
100-item page, with bounded delays of 0, 1, 2, 4, 8, 15, and 30 seconds. Every poll
reapplies all canonical title/body/schema, release and CWS identity, linkage,
open/closed state, bot-author, malformed-record, and duplicate checks. Once the
exact expected chain is visible, a short delay and one more complete confirmation
scan must agree. A malformed, mismatched, or duplicate ledger at any poll fails
immediately. A chain that never becomes visible and stable fails closed before the
next mutation.

The accepted staged states are:

- upload-attempt/v1 alone: ordinary retry is blocked; only the specifically pinned
  skipped-upload incident may prove eligibility and claim one resume attempt;
- upload-attempt/v1 → upload-success/v1: completed normal upload chain;
- upload-attempt/v1 → upload-resume-attempt/v1: the same recovery run may make its
  one upload call, but no later recovery can be claimed;
- upload-attempt/v1 → upload-resume-attempt/v1 → upload-success/v2: completed
  recovery chain, accepted by the separate submit verifier;
- either completed chain → submit-attempt/v1: submission was attempted and normal
  no-retry rules apply.

Success/v1 with a resume ledger, success/v2 without the exact attempt and resume,
both success versions, wrong run identity, bad links, or any other combination is
invalid. The normal path remains upload-attempt/v1 → upload-success/v1 and never
uses the Actions API.

## Recovery and revocation

- Every error after an upload or publish request may have been sent is an unknown
  outcome. This includes a timeout or abort, network exception, non-2xx response,
  non-JSON success, or response identity/schema/version mismatch. Do not rerun
  the failed stage. Run read-only `status` and inspect the Developer Dashboard. An
  exact pending or published version is an audited no-op; any other state requires
  manual resolution.
- A matching upload-attempt or submit-attempt issue always blocks the ordinary
  automated retry path unless exact pending/published state makes submission a
  read-only no-op. The sole exception is the one-shot resume claim for the exact
  pinned issue #9 incident after all prior-run proof succeeds. The legacy combined
  path has the same fail-closed retry behavior. Each issue blocks whether open or
  closed, is repository-wide, does not expire, and is not split by workflow ref.
  Automation never edits, closes, or deletes it. Issue #9 must remain open,
  unchanged, and permanent; do not use administrator editing or deletion as a
  bypass.
- An upload-attempt issue without its canonical linked synchronous-success issue
  can never authorize submission. It blocks another ordinary upload. Only issue
  #9, while it is still the lone staged ledger, is eligible for the pinned proof
  and one resume claim described above. Do not fabricate, edit, close, or delete a
  success record. A success issue with no exact pending/published state authorizes
  submission only through the separately confirmed and approved submit run.
  `fetchStatus` alone cannot prove which unsubmitted draft bytes are present.
- Creating upload-resume-attempt/v1 consumes the recovery permanently. If that
  recovery run then fails, is cancelled, times out, receives an ambiguous CWS
  response, or does not create upload-success/v2, the attempt + resume chain blocks
  every second recovery. Do not rerun the job or dispatch `resume-upload` again;
  inspect the Dashboard and resolve manually. The same rule applies if the success
  ledger cannot become stably list-visible after a synchronous upload proof.
- Recovery accepts GitHub's read-only Actions run/job/step metadata as proof and
  intentionally does not download logs. This exception works only while every
  pinned REST response is available and exactly recognized. API unavailability,
  retention loss, timeout, schema ambiguity, or any unknown state blocks recovery;
  none may be treated as evidence that the upload was skipped.
- A submit-attempt issue without exact visible pending/published `0.3.0` state is an
  uncertain outcome and blocks retry. Inspect the Dashboard and resolve manually.
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
