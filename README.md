# Refund console (Node + React)

Upload the refund journal → preview the exact amounts Shopify will refund →
approve → process. The Shopify Admin token lives only on the server and is
never sent to the browser.

## Layout

```
refund-console-react/
  server/
    index.js      Express API + job/plan orchestration, serves the built client
    refund.js     Shopify logic: parse xlsx, resolve orders, suggestedRefund, refundCreate
  client/         React (Vite) frontend
    src/App.jsx   the whole UI
```

## Refund rules (same as the batch scripts)

- Order resolved by name (`name:ORD519056`); set a prefix if yours are `#ORD...`.
- Skipped (not refunded) with a reason: `already_refunded`,
  `no_refundable_payment` (COD/manual), `order_not_found`, `no_refundable_lines`.
- Every SKU listed for an order is refunded at Shopify's computed full-line
  amount (the sheet's 4th column is ignored).
- Shipping is refunded only when the whole order is refunded (every still-
  refundable line, at full quantity).
- Nothing is charged until you approve on the review screen.

## Run

```bash
# 1. backend deps
npm install

# 2. build the React client (installs its own deps)
npm run build

# 3. configure + start
export SHOPIFY_STORE="your-store.myshopify.com"
export SHOPIFY_ADMIN_TOKEN="shpat_..."   # read_orders + write_orders
npm start
# open http://localhost:3000
```

### Developing the UI with hot reload

```bash
# terminal 1
npm start                 # API on :3000
# terminal 2
npm --prefix client run dev   # Vite on :5173, proxies /api to :3000
```

## Note

Anyone who can reach the server can process refunds — put auth in front of it
before hosting it anywhere but your own machine.
