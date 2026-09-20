# Kirana Backend — Frontend Integration Guide

## 1. Overview & Base URLs

- **Production Backend URL**: `https://kirana-backend-9t5z.onrender.com`
- **Frontend API Base URL**: `https://kirana-backend-9t5z.onrender.com/api/v1`
- **Production Frontend**: `https://kirana-frontend-tau.vercel.app`
- **Health Check URL**: `https://kirana-backend-9t5z.onrender.com/health`

---

## 2. CORS & Network Security

The production backend has been verified for secure CORS origin matching:
- **Allowed Origin**: `https://kirana-frontend-tau.vercel.app` (Strict, no wildcard)
- **Supported Methods**: `GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS`
- **Supported Headers**: `Authorization, Content-Type, Accept`
- **Credentials**: Supported (`credentials: true`)
- **Preflight**: Browser `OPTIONS` requests receive HTTP `204 No Content` with appropriate access-control headers.
- **Security Headers**: Managed by Helmet (`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`).

---

## 3. Standard Response Envelopes & Error Formats

### 3.1 Success Response Envelope
All successful API responses return JSON with `status: "success"`:

```json
{
  "status": "success",
  "data": { ... }
}
```

For paginated listing endpoints, the pagination object is embedded alongside:
```json
{
  "status": "success",
  "data": {
    "customers": [ ... ],
    "pagination": {
      "total": 42,
      "page": 1,
      "limit": 20,
      "totalPages": 3,
      "hasNext": true,
      "hasPrevious": false
    }
  }
}
```

### 3.2 Error Response Envelopes
All error responses return JSON with `status: "error"`. Sensitive data (stack traces, database URLs, secrets) are never leaked.

#### Standard Operational Error (401, 404, 409):
```json
{
  "status": "error",
  "message": "Customer not found."
}
```

#### Validation Error (400 Bad Request):
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "phoneNumber",
      "message": "Phone number must be exactly 10 digits"
    }
  ]
}
```

#### Rate Limiting (429 Too Many Requests):
Returned when authentication rate limits are exceeded (default: 5 login attempts per 15-minute window per IP):
```json
{
  "status": "error",
  "message": "Too many login attempts. Please try again later."
}
```

#### Server Error (500 Internal Server Error):
```json
{
  "status": "error",
  "message": "Something went wrong on the server"
}
```

---

## 4. Authentication Flow & Headers

Authentication uses JSON Web Tokens (JWT).

### 4.1 Login
- **Endpoint**: `POST /api/v1/auth/login`
- **Auth Required**: None
- **Content-Type**: `application/json`

#### Request Body:
```json
{
  "email": "merchant@example.com",
  "password": "SecurePassword123"
}
```

#### Success Response (200 OK):
```json
{
  "status": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "7b8f9e20-3b1a-4d2c-8f4e-5a6b7c8d9e0f",
      "email": "merchant@example.com",
      "businessName": "Shree Kirana Store"
    }
  }
}
```

### 4.2 Authenticated Requests
For all protected routes, include the JWT in the `Authorization` HTTP header:

```http
Authorization: Bearer <JWT_TOKEN>
```

---

## 5. Implemented API Endpoints & Request Examples

### 5.1 Health Check
- **Method**: `GET`
- **Path**: `/health`
- **Auth Required**: No
- **Response (200 OK)**:
```json
{
  "status": "success",
  "message": "Server is healthy",
  "timestamp": "2026-09-18T17:26:04.575Z"
}
```

---

### 5.2 Customers API

#### A. Create Customer
- **Method**: `POST`
- **Path**: `/api/v1/customers`
- **Auth Required**: Bearer JWT
- **Request Body**:
```json
{
  "name": "Ramesh Kumar",
  "phoneNumber": "9876543210",
  "lendingRate": 2.0,
  "depositRate": 1.0,
  "interestRate": 2.0,
  "defaultInterestType": "SIMPLE",
  "compoundingFrequency": "MONTHLY"
}
```
*Notes*:
- `phoneNumber` must be exactly 10 numeric digits.
- `compoundingFrequency`: `"DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY" | "CUSTOM"`.
- If `"CUSTOM"`, `customCompoundDays` (integer > 0) is required.

- **Response (201 Created)**:
```json
{
  "status": "success",
  "data": {
    "customer": {
      "id": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
      "userId": "7b8f9e20-3b1a-4d2c-8f4e-5a6b7c8d9e0f",
      "name": "Ramesh Kumar",
      "phoneNumber": "9876543210",
      "lendingRate": "2.00",
      "depositRate": "1.00",
      "interestRate": "2.00",
      "defaultInterestType": "SIMPLE",
      "compoundingFrequency": "MONTHLY",
      "customCompoundDays": null,
      "advanceBalance": "0.00",
      "isActive": true,
      "createdAt": "2026-09-18T17:00:00.000Z",
      "updatedAt": "2026-09-18T17:00:00.000Z"
    }
  }
}
```

#### B. List All Customers
- **Method**: `GET`
- **Path**: `/api/v1/customers`
- **Auth Required**: Bearer JWT
- **Query Parameters**:
  - `page` (default: 1)
  - `limit` (default: 20, max: 100)
  - `sort` (one of: `name`, `phoneNumber`, `lendingRate`, `depositRate`, `createdAt`, `updatedAt`; default: `name`)
  - `order` (`asc` | `desc`; default: `asc`)
- **Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "customers": [
      {
        "id": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
        "userId": "7b8f9e20-3b1a-4d2c-8f4e-5a6b7c8d9e0f",
        "name": "Ramesh Kumar",
        "phoneNumber": "9876543210",
        "lendingRate": "2.00",
        "depositRate": "1.00",
        "interestRate": "2.00",
        "advanceBalance": "0.00",
        "isActive": true,
        "createdAt": "2026-09-18T17:00:00.000Z",
        "updatedAt": "2026-09-18T17:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "limit": 20,
      "totalPages": 1,
      "hasNext": false,
      "hasPrevious": false
    }
  }
}
```

#### C. Search Customers
- **Method**: `GET`
- **Path**: `/api/v1/customers/search?q=Ramesh`
- **Auth Required**: Bearer JWT
- **Query Parameters**:
  - `q` (string search term matching customer name or phone)
  - `page`, `limit`, `sort`, `order`
- **Response (200 OK)**: Same paginated shape as List All Customers.

#### D. Get Single Customer
- **Method**: `GET`
- **Path**: `/api/v1/customers/:id`
- **Auth Required**: Bearer JWT
- **Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "customer": {
      "id": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
      "name": "Ramesh Kumar",
      "phoneNumber": "9876543210",
      "lendingRate": "2.00",
      "depositRate": "1.00",
      "interestRate": "2.00",
      "defaultInterestType": "SIMPLE",
      "compoundingFrequency": "MONTHLY",
      "advanceBalance": "0.00",
      "isActive": true,
      "createdAt": "2026-09-18T17:00:00.000Z",
      "updatedAt": "2026-09-18T17:00:00.000Z"
    }
  }
}
```

#### E. Update Customer
- **Method**: `PATCH`
- **Path**: `/api/v1/customers/:id`
- **Auth Required**: Bearer JWT
- **Request Body** (at least one field required):
```json
{
  "name": "Ramesh K.",
  "interestRate": 3.0,
  "effectiveDate": "2026-10-01T00:00:00.000Z"
}
```
*Note on `interestRate` & `effectiveDate`*: Rate changes are non-retroactive. Prior interest is accrued using the previous rate up to `effectiveDate`, and the new rate is applied from `effectiveDate` onward.
- **Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "customer": { ... }
  }
}
```

#### F. Delete/Archive Customer
- **Method**: `DELETE`
- **Path**: `/api/v1/customers/:id`
- **Auth Required**: Bearer JWT
- **Response (200 OK)**:
```json
{
  "status": "success",
  "message": "Customer archived successfully.",
  "data": null
}
```

---

### 5.3 Transactions API

#### A. Create Transaction (DEBIT / Purchase)
- **Method**: `POST`
- **Path**: `/api/v1/transactions`
- **Auth Required**: Bearer JWT
- **Request Body**:
```json
{
  "customerId": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
  "type": "DEBIT",
  "amount": 1500.00,
  "date": "2026-09-18T10:00:00.000Z",
  "interestStartDate": "2026-09-18T10:00:00.000Z",
  "remarks": "Grocery items purchase"
}
```
*Notes*:
- `amount` must be positive with up to 2 decimal places.
- `date` and `interestStartDate` cannot be in the future.
- `interestStartDate` cannot be before `date`.
- Optional per-entry overrides for DEBIT: `interestType`, `interestRate`, `compoundingFrequency`, `customCompoundDays`, `dueDate`.

#### B. Create Transaction (CREDIT / Payment)
- **Method**: `POST`
- **Path**: `/api/v1/transactions`
- **Auth Required**: Bearer JWT
- **Request Body**:
```json
{
  "customerId": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
  "type": "CREDIT",
  "amount": 1000.00,
  "date": "2026-09-18T12:00:00.000Z",
  "interestStartDate": "2026-09-18T12:00:00.000Z",
  "remarks": "UPI Payment received",
  "targetEntryId": null
}
```
*Notes*:
- `targetEntryId` is optional. When specified, targets an exact unsettled DEBIT entry.
- Interest parameters (`interestType`, `interestRate`, etc.) are prohibited on CREDIT transactions.

- **Response (201 Created)**:
```json
{
  "status": "success",
  "data": {
    "transaction": {
      "id": "c71a3618-97c2-488f-9a99-0d1279ec3e5f",
      "customerId": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
      "type": "CREDIT",
      "amount": "1000.00",
      "date": "2026-09-18T12:00:00.000Z",
      "interestStartDate": "2026-09-18T12:00:00.000Z",
      "interestType": null,
      "interestRate": null,
      "compoundingFrequency": null,
      "customCompoundDays": null,
      "dueDate": null,
      "targetEntryId": null,
      "outstandingPrincipal": null,
      "isSettled": false,
      "settledAt": null,
      "settledByPaymentId": null,
      "interestCharged": null,
      "isSystemGenerated": false,
      "createdByPaymentId": null,
      "remarks": "UPI Payment received",
      "isVoided": false,
      "createdAt": "2026-09-18T12:00:00.000Z",
      "updatedAt": "2026-09-18T12:00:00.000Z"
    }
  }
}
```

#### C. Get Transaction by ID
- **Method**: `GET`
- **Path**: `/api/v1/transactions/:id`
- **Auth Required**: Bearer JWT
- **Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "transaction": { ... }
  }
}
```

#### D. Void Transaction
- **Method**: `PATCH`
- **Path**: `/api/v1/transactions/:id/void`
- **Auth Required**: Bearer JWT
- **Response (200 OK)**:
```json
{
  "status": "success",
  "message": "Transaction voided successfully.",
  "data": {
    "transaction": {
      "id": "c71a3618-97c2-488f-9a99-0d1279ec3e5f",
      "isVoided": true,
      ...
    }
  }
}
```

#### E. List Customer Transactions
- **Method**: `GET`
- **Path**: `/api/v1/customers/:customerId/transactions`
- **Auth Required**: Bearer JWT
- **Query Parameters**:
  - `page` (default: 1)
  - `limit` (default: 20, max: 100)
  - `sort` (`date` | `amount` | `interestStartDate` | `dueDate` | `createdAt`; default: `date`)
  - `order` (`asc` | `desc`; default: `desc`)
  - `type` (`DEBIT` | `CREDIT`; optional)
  - `isVoided` (`false` | `true` | `all`; default: `false`)
  - `startDate`, `endDate` (ISO date filter; optional)
- **Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "transactions": [ ... ],
    "pagination": {
      "total": 5,
      "page": 1,
      "limit": 20,
      "totalPages": 1,
      "hasNext": false,
      "hasPrevious": false
    }
  }
}
```

---

### 5.4 Customer Ledger API

#### Customer Ledger with Dynamic Interest Calculation
- **Method**: `GET`
- **Path**: `/api/v1/customers/:customerId/ledger`
- **Auth Required**: Bearer JWT
- **Query Parameters**:
  - `calculationDate` (optional ISO 8601 string, e.g. `2026-09-18T00:00:00.000Z`; defaults to current server timestamp)

- **Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "customer": {
      "id": "e0b9d99c-8598-4c8d-8ad1-229ef5e917d5",
      "name": "Ramesh Kumar",
      "phoneNumber": "9876543210",
      "lendingRate": "2.00",
      "depositRate": "1.00",
      "interestRate": "2.00",
      "advanceBalance": "0.00",
      "isActive": true
    },
    "summary": {
      "status": "Due",
      "displayAmount": 1530.00,
      "totalPrincipal": 1500.00,
      "accruedInterest": 30.00,
      "totalDue": 1530.00,
      "advance": 0.00,
      "totalMoneyLent": 1500.00,
      "totalMoneyReceived": 0.00
    },
    "openEntries": [
      {
        "transactionId": "c71a3618-97c2-488f-9a99-0d1279ec3e5f",
        "date": "2026-08-18T00:00:00.000Z",
        "principalAmount": 1500.00,
        "accruedInterest": 30.00,
        "totalDue": 1530.00,
        "isSystemGenerated": false
      }
    ],
    "settledEntries": [
      {
        "transactionId": "b11a3618-97c2-488f-9a99-0d1279ec3e11",
        "date": "2026-07-01T00:00:00.000Z",
        "principalAmount": 500.00,
        "interestCharged": 10.00,
        "settledAt": "2026-08-01T00:00:00.000Z",
        "settledByPaymentId": "a22a3618-97c2-488f-9a99-0d1279ec3e22"
      }
    ],
    "transactions": [ ... ]
  }
}
```

*Note on Global Ledger (`GET /api/v1/ledger`)*:
The backend implements customer-level ledger accounting at `GET /api/v1/customers/:customerId/ledger`. There is no global un-scoped `/api/v1/ledger` route. To display customer balances on a dashboard, the frontend iterates over active customers or fetches the customer list.

---

## 6. Frontend Data Guidelines (Financial & Dates)

### 6.1 Financial Representation
- **Decimals in Database**: Stored as exact PostgreSQL `Decimal(12, 2)`.
- **Numbers in Ledger Summary & Open Entries**: Serialized as numbers rounded to 2 decimal places (e.g. `1500.00`, `30.00`).
- **Best Practice for Frontend**: Do NOT perform arbitrary floating point operations (e.g. `0.1 + 0.2`) on the client. For calculations or currency formatting, use `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`.

### 6.2 Date Representation
- All dates are formatted as ISO 8601 UTC strings: `YYYY-MM-DDTHH:mm:ss.sssZ`.
- Always parse dates using `new Date(isoString)` or date libraries like `date-fns` / `dayjs`.
- Always pass ISO 8601 strings when querying with `calculationDate`, `startDate`, or `endDate`.

---

## 7. WhatsApp Integration Status

> **Status**: WhatsApp backend integration is not currently implemented.
> 
> The backend does not currently have Meta Graph API or WhatsApp Business credentials configured. If the frontend displays a WhatsApp button, it should use standard client-side `https://wa.me/<phoneNumber>?text=...` URI schemes directly from the browser.
