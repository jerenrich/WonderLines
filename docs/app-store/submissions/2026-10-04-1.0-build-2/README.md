# Submitted App Store baseline: 1.0 (2)

Wonder Lines was submitted by Jordan Erenrich on **4 October 2026 at 8:29 AM**. App Store Connect showed **Waiting for Review** when this record was collected after submission. The displayed time has minute precision; Europe/London is inferred from the session timezone. This records the submitted choices, not a later approval.

[Open the submission in App Store Connect](https://appstoreconnect.apple.com/apps/6817505650/distribution/reviewsubmissions/details/76e4aec3-d175-4425-9989-8fd79696755b).

| Item | Submitted value |
| --- | --- |
| App name | Wonder Lines |
| Subtitle | Dream it. Print it. Color it. |
| Apple ID / SKU | 6817505650 / wonderlines-ios |
| Bundle ID | com.jordan.family.ColoringSheets |
| Version / build | 1.0 / 2 |
| Submission ID | 76e4aec3-d175-4425-9989-8fd79696755b |
| Build ID | 85f200ea-fb06-4d5c-a4c7-8787f601abcb |
| Language / category | English (U.S.) / Graphics & Design; no secondary category |
| Price / distribution | Free; public, discoverable on the App Store |
| Release | Automatically release this version after approval; no scheduled date |
| Age rating | 9+ in 172 regions; Vietnam 12+, Brazil 10+, Korea All Ages |
| Made for Kids | Not selected; age category/override “Not Applicable” |
| Sign-in for review | Not required; anonymous service account created automatically |
| Privacy policy | https://jerenrich.github.io/WonderLines/privacy.html |
| Support / marketing | https://jerenrich.github.io/WonderLines/ |
| License | Apple’s Standard License Agreement |
| App Clip / Game Center | None / disabled |
| Screenshots | Four iPhone 6.9-inch; two iPad 13-inch; no preview videos |
| Additional compatibility | Apple silicon Mac enabled, automatic macOS 14.0; Vision Pro enabled |

## Exact copy and evidence

[submission.json](submission.json) is the structured record, including every listing text field and the full App Review notes. [listing-copy.txt](listing-copy.txt) makes the exact copy easy to compare or reuse. The description’s opening line includes the owner's edit: “And then print with an easy button.  No sign in required”. It describes generating one to three sheets; it does not publish a numeric daily quota.

[evidence/](evidence/) contains the visible App Store Connect page snapshots and all seven saved age questionnaire steps. We inspected these after submission, without changing Apple’s forms. Current visible values take precedence over earlier local drafts. Values not rechecked in the UI are identified as coming from the owner’s replies or the preceding build/upload/privacy-publish workflow.

The older `docs/app-store/2026-10-04/` folder is a preparation folder. Its name, subtitle, optional What's New and beta copy differ from the submitted values. Its screenshots were refreshed after the first upload. Do not treat that folder or its ZIP as the submission record.

## Privacy, rights, and encryption

The published privacy label declares **Other User Content, User ID, Device ID, Product Interaction, Performance Data, and Other Diagnostic Data**. Each is used for **App Functionality**, **linked to the user**, and **not used for tracking**. No other data types or purposes were selected. The current published label verifies the types, purpose and linking; individual tracking answers also come from the preceding publish workflow. The optional User Privacy Choices URL is blank.

The owner explicitly authorized publication and agreed to maintain accurate disclosures. [privacy-policy.html](privacy-policy.html) and its [style.css](style.css) preserve the published policy from commit `16c38010d82d3ca669552932548bce140f10f9d0`, effective 4 October 2026. The public privacy/support contact is `jordan.erenrich@gmail.com`.

The policy covers prompts, generated images, drawing complexity, dimensions and model choices; anonymous account credentials and App Attest/device information; usage, cost and diagnostic records; hosted Cloudflare services and configured image providers. It explains local storage, add-only Photos permission, share/print destinations, retention limitations, provider/Gateway processing, and requests to delete data. It does not promise a fixed automatic backend deletion period or no provider training. Read the archived policy itself when auditing these commitments.

Apple’s saved Content Rights answer is **“No, this app does not contain, show, or access third-party content.”** Separately, the owner confirmed that the AI provider accounts and model licenses permit displaying and distributing generated images. These are distinct recorded choices; this audit does not independently establish license rights.

For build 2, the saved encryption answer was **“None of the algorithms mentioned above”**, based on use of Apple operating-system networking and cryptography rather than an app-supplied encryption implementation. The actual archive has no `ITSAppUsesNonExemptEncryption` key; the declaration was answered in App Store Connect. Recheck it if encryption implementation changes.

## Age-rating answers

[age-rating-answers.json](age-rating-answers.json) records all saved choices. Horror/fear themes, cartoon/fantasy violence, and guns/other weapons are **Infrequent**. All other content-frequency answers are **None**. Parental controls, age assurance, unrestricted web access, publicly distributed user-generated content, social media, social media disabled under 13, messaging/chat, advertising, health/wellness topics, gambling, and loot boxes are **No**.

The in-app “age” setting controls drawing difficulty. It is not identity/age verification or a parental control. The app was not submitted in the Made for Kids category. The policy's family language does not change that saved category choice. For operating systems earlier than 26, Apple displays “Global rating of 9+ with regional exceptions”; those older-system regional details were not separately inspected.

## Submitted build and images

The app source baseline is commit `7e541a87eaa5c7d921695298a8bccee5b56c57d6`. The archive also used local Xcode signing/project-format changes; the checkout was not entirely clean. The actual uploaded IPA is identified by SHA-256:

```
9bfa7727c8a80f1658ed53c6006073a2cbc5c5d5ac414328190dc93f2b8ca5f9
```

[build-info.json](build-info.json) captures selected fields from that archive: version 1.0 (2), iOS 17 minimum, iPhone/iPad, Xcode 27.0 (27A266a), live service configuration and the exact Photos permission text. Distribution signature checks passed, with `get-task-allow` false and production App Attest. The binary and private signing assets are retained locally, not in this public baseline.

The backend deployment recorded for this release is `ec0f2053-226d-4ba6-a81d-b510b0c967c8`; [its CI run](https://github.com/jerenrich/WonderLines/actions/runs/37185459423) deployed the source changes. Offline Worker checks passed; simulator tests recorded 43 tests, two intentional skips, zero failures. No paid image generation was needed to test the quota change.

Shipping behavior allows **1–3 images per generation, default 3**, and **at most 100 reserved images per anonymous service account per UTC day**, including credit-funded requests. The day resets at **00:00 UTC**. Failed/interrupted reservations count; recovery and repeating the same idempotent generation do not create new reservations. This is an account limit, not verification that the same natural person cannot use another installation/account. Runtime provider routes and dashboard variables were not fully exported for this audit.

[screenshots-manifest.json](screenshots-manifest.json) records the exact uploaded image order, dimensions and checksums. Original files were recovered from the upload backups and matched the original capture manifest. Their filenames/order were checked against the live submission; Apple-hosted pixels were not independently downloaded or hashed.

- iPhone 6.9-inch: dinosaur gallery, describe your idea, age/generation settings, save/share/print. The 6.5-inch listing uses these screenshots.
- iPad 13-inch: dinosaur gallery and age/generation settings. The other prepared iPad captures were not uploaded.

The screenshots used simulator UI and a locally supplied AI-created dinosaur illustration. [artwork-prompt.txt](artwork-prompt.txt) preserves its generation brief. App Review notes explicitly disclosed this fixture, and that it is absent from the shipping source. The screenshots predate the refreshed build-2 quota caption; do not silently replace this archive with the newer local captures. [app-icon.png](app-icon.png) preserves the build-source icon. Other display-family inheritance was not independently inventoried.

## Other saved choices and open observations

[prices.csv](prices.csv) records all 175 displayed free-price entries and currencies; the base country is the United States. Tax category is App Store software. Public distribution and the reduced-price Apple School Manager volume-purchase option are checked. Mac availability is enabled, but developer verification of Mac compatibility has not been completed. Vision Pro availability is enabled as an iPhone/iPad-compatible app.

The country-availability section still showed **Set Up Availability**. The 175-region price schedule does not establish which download regions are enabled. Confirm availability before relying on a geographic launch assumption. Digital Services Act account status was not inspected; App Information showed a Set Up link. No separate Vietnam game-license or medical-device declaration was verified. Production/sandbox App Store server-notification URLs both showed Set Up URL.

No in-app purchase entries or auto-renewing subscription groups were displayed. Subscription billing grace period was not configured; streamlined purchasing showed Turned On. The non-renewing subscriptions Manage page was not inspected. Accessibility labels showed Get Started, with no public labels configured; this does not establish which accessibility features the app supports.

TestFlight Test Information is separate from this App Store submission: “Show approved screenshots and category” is checked, while beta description, feedback email, URLs, beta review contact and notes are blank. Build-specific What to Test and external invitations/groups were not fully inspected. Earlier beta copy remains a draft.

Review contact names were verified in Apple’s form; email and phone were browser-redacted. Owner-supplied contact details are recorded separately. The public record includes the already-public email; the review-only phone is in a Git-ignored `review-contact.private.json` local annex. This annex is not included in public checksums and must be preserved privately or recovered from the owner if the checkout is replaced.

## Audit future changes

Run from the main checkout before preparing a new release:

```sh
python3 Scripts/audit_app_store.py --include-working-tree
```

The script verifies the archived files against [integrity.json](integrity.json) and flags changed app/backend/configuration files for manual review against the baseline. Exit 0 means the archive is intact and no covered source changes were detected; exit 1 means review is needed; exit 2 means archive verification or Git inspection failed. It does not query Apple or certify compliance. Its path rules are deliberately broad; review changes to runtime service settings even if no repository file changes.

| Change | Compare/update before submission |
| --- | --- |
| New providers/models, prompts sent elsewhere, account/device identity, retention, logging, analytics, tracking, training or deletion behavior | Policy and privacy types, purposes, linking/tracking answers; provider terms/settings and rights |
| Content filters, model behavior, public galleries, chat/social features, web access, ads, gambling or child-directed positioning | Every affected age-rating answer, regional rating and Made for Kids choice |
| Images per batch, quotas, defaults, recovery, supported platforms, Photos/share/print or sign-in | Listing claims, screenshots, reviewer test instructions, permission wording and compatibility |
| Encryption/dependencies or export requirements | Build encryption declaration and any required documentation |
| Paid features, subscriptions, regional launch, support/operator/contact or license changes | Pricing, distribution/availability, legal URLs, rights/license and review contact |
| Accessibility labels or support | Actual supported behavior and corresponding Apple declarations |

For each later submission, create a **new dated baseline** from the saved Apple values and the exact uploaded assets. Include the new source commit, build/IPA hash and deployment identifiers. Compare it to this record, explain intentional changes, and update Apple/policy values as appropriate. Keep this submission's files unchanged; add a later observation or correction separately, with provenance. Update the parent README's current-baseline pointer only after capturing the new submission.
