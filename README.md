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

The command is designed to be started manually around 09:55 local time. It opens and prepares the GLM Coding page first, waits until the next available 10:00 window, then retries the official page checkout action in the same browser session until one of these happens:

- a checkout link is created
- the local time reaches 10:05
- you stop the process manually, for example with `Ctrl+C`

If you start it after 10:05, it waits for the next day's 10:00 window instead of exiting immediately. While waiting, it prints a countdown like `Time remaining: 0h 05m 00s` to stderr.

Retry interval defaults to 500ms and can be changed with `GLM_RETRY_INTERVAL_MS`:

```sh
GLM_RETRY_INTERVAL_MS=500 npm run buy:glm-coding
```

## Web UI

```sh
npm run ui
```

Open `http://127.0.0.1:3000`. The local page lets you choose the next execution time, set the retry interval, view the countdown, start the checkout task, and stop the running task without exiting the UI server.

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

This CLI does not pay, store passwords, bypass verification, or poll indefinitely. It only attempts to create an unpaid checkout/order link through the official GLM Coding web flow during the bounded 10:00-10:05 retry window.
