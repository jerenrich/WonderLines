# Credential recovery and deployment verification — 19 October 2026

These records describe the service and credential settings observed on 19 October. They are historical evidence, not a current inventory or expiry check.

The expired OpenAI project key was replaced by the owner. One authorized Flare generation succeeded through the gateway, and recovery returned the same saved image. See [diagnosis](credential-diagnosis.json), [verification](restoration-verification.json), and the [result](restored-flare-test.png).

The GitHub deployment token was replaced with a restricted token without an expiry. The old token was revoked, then [GitHub deployment run 44](https://github.com/jerenrich/WonderLines/actions/runs/39328061234) passed all offline checks and deployed both Workers using the replacement. See [the expiry audit](credential-expiry-audit.json) and [permission/deployment record](deployment-token-hardening.json).

Final screenshot evidence:

- [Replacement token permissions and expiry](deploy-token-replacement-saved.png)
- [Inventory after old-token revocation](old-deploy-token-revoked.png)
- [Successful deployment after revocation](post-revocation-deployment-success.png)

## Publication review — 22 October 2026

All 15 operation screenshots were visually inspected and checked with local text recognition. No complete API key, access token, password or private key was found. Three intermediate setup screenshots contained the account email; those and redundant setup captures remain local and are excluded by this folder's `.gitignore`. The four retained images show final configuration, deployment evidence or the generated test image.

JSON fields naming other screenshots refer to those local historical captures. They are not missing public attachments. Credential IDs and account IDs in the records identify configuration objects; credential values are not included. This review did not change, replace or revoke any credential.
