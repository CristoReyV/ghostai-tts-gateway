# Lifetime member access

`lifetime` is a third member and billing plan, displayed as **De por vida**. Sheet/import aliases also accept `De por vida`, `Vitalicio` and `Vitalicia`. Unknown plans are rejected before creating clients or credentials.

Creation uses the existing OWNER service and keeps PENDING, null activation/expiration and no email delivery. Activation is still single-use; it sets ACTIVE and activatedAt while leaving member/key expiration null. Revocation, encrypted delivery and OWNER/OPERATOR permissions are unchanged. Lifetime access cannot be renewed into a dated monthly/annual period. The database also rejects expiration dates for lifetime members.

The price is per member, with no fixed lifetime price or automatic charge. It uses the existing commercial profile, Sheet amount and OWNER **Corregir importe** action. Price changes preserve the append-only payment history and do not confirm payment. A later Sheet sync previews differences against any OWNER price before replacing it.

Lifetime income appears in totals and its own plan breakdown. It is excluded from monthly MRR and upcoming renewal forecasts. Existing active plan changes still require OWNER review; only clean PENDING plan changes can be synchronized automatically.
