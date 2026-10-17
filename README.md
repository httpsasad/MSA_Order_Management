# MSA Order Management — Complete Dual-Portal Solution

A complete, role-separated Order Management System (OMS) built specifically for Pakistani E-Commerce brands.

---

## 🎯 The 2 Dedicated Portals

### 1. 👑 Admin & Owner Suite (`admin_portal.html` / `http://localhost:5000/admin`)
*Reserved for the business owner & operations managers.*
- **Executive Dashboard**: Real-time sales metrics, order pipeline, courier delivery rates, and money separation.
- **Shipment Queue & Bulk Booking**: Direct API booking with **PostEx**, **Trax**, and **Leopards**.
- **Real-Time Consignment Tracking**: Print packing slips & labels, event history timeline.
- **COD Reconciliation Engine**: Expected COD vs. Courier-reported vs. Bank-deposited matching + CSV Export.
- **Staff Management**: Add callers, deactivate staff, and 1-click **Round-Robin** call distribution.
- **Shopify Stores & Webhooks**: Real-time webhook listener (`/api/webhooks/shopify/orders-create`) + 1-click JSON/CSV Order Importer.
- **Courier API Settings**: Encrypted credentials for PostEx, Trax, and Leopards.
- **Live Calling Monitor**: Real-time supervision of which caller is handling which customer.

### 2. 📞 Calling Team Portal (`caller_portal.html` / `http://localhost:5000/caller`)
*Given directly to your call-center agents/callers.*
- **Agent Profile Selector**: Agents pick their name (Sadia, Imran, Kamran, etc.).
- **Segmented Queues**: Pending Call, No Answer, Call Back Later, Wrong Number, Cancelled.
- **Customer Privacy & Focus**: Zero financial balances, zero courier API keys, and zero store settings visible.
- **Click-to-Call**: 1-click dialer via `tel:` with automated Pakistani mobile number normalization (`+92`).
- **Live Edit Order Modal**: Callers can edit customer name, phone number, house/street/city address, item variation/size, and COD amount on the spot.
- **Smart Dispositions**: Confirm order, reschedule with `datetime-local` picker, record cancellation reasons.
- **Real-Time Sync**: Every confirmation or edit immediately syncs back to the Admin Suite.

---

## 🚀 How to Run & Access

1. **Start the Central Server**:
   ```bash
   node server.js
   ```
2. **Access Links**:
   - **Admin Portal**: [http://localhost:5000/admin](http://localhost:5000/admin) *(Aap ke apne liye)*
   - **Calling Team Portal**: [http://localhost:5000/caller](http://localhost:5000/caller) *(Calling team ko dene ke liye)*
