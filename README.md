# GLM Coding Plan Checkout CLI

Creates a GLM Coding `Pro` monthly recurring checkout link and stops before payment.

## Install

```sh
npm install
```

## Run

```sh
npm run buy:glm-coding
```

On first run, a browser window opens at `https://bigmodel.cn/glm-coding`. Log in manually, then press Enter in the terminal. The login session is stored in `.auth/glm-coding/storageState.json`, which is ignored by git.

The command prints JSON to stdout. Progress and login prompts are written to stderr.

Successful output:

```json
{
  "status": "checkout_ready",
  "plan": "pro",
  "billing": "monthly_recurring",
  "checkoutUrl": "https://bigmodel.cn/...",
  "orderId": "optional-if-available"
}
```

Known failure statuses:

- `login_required`
- `out_of_stock`
- `plan_not_found`
- `checkout_not_created`
- `contract_changed`

## Safety Boundary

This CLI does not pay, store passwords, bypass verification, or poll for stock. It only attempts to create an unpaid checkout/order link through the official GLM Coding web flow.
