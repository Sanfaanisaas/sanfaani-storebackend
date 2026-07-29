import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const API_URL = process.env.API_URL || "http://localhost:5000/api";
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_for_testing";

const routes = [
  { path: "/auth/refresh", method: "POST", auth: true },
  { path: "/auth/logout", method: "POST", auth: true },
  { path: "/cart", method: "GET", auth: true },
  { path: "/cart/items", method: "POST", auth: true },
  { path: "/cart/items/SKU123", method: "DELETE", auth: true },
  { path: "/cart/merge", method: "POST", auth: true },
  { path: "/checkout", method: "POST", auth: true },
  { path: "/orders/mine", method: "GET", auth: true },
  { path: "/orders/eligible-pickup", method: "GET", auth: true },
  { path: "/orders/123/verify-bank-transfer", method: "PATCH", auth: true, roles: ["product_admin", "super_admin"] },
  { path: "/orders/123/upload-receipt", method: "POST", auth: true },
  { path: "/orders/123/receipt", method: "GET", auth: true },
  { path: "/orders/queue", method: "GET", auth: true, roles: ["super_admin"] },
  { path: "/payments/initiate", method: "POST", auth: true },
  { path: "/repairs", method: "POST", auth: true },
  { path: "/repairs/123/intake", method: "PATCH", auth: true, roles: ["super_admin"] },
  { path: "/repairs/queue", method: "GET", auth: true, roles: ["super_admin"] },
  { path: "/inventory/stock-movements", method: "POST", auth: true, roles: ["inventory_officer", "super_admin"] },
  { path: "/claims/mine", method: "GET", auth: true },
  { path: "/claims/123/status", method: "PATCH", auth: true, roles: ["support_officer", "super_admin"] },
  { path: "/support-tickets/mine", method: "GET", auth: true },
  { path: "/support-tickets", method: "POST", auth: true },
  { path: "/support-tickets/123/reply", method: "POST", auth: true },
  { path: "/support-tickets/123/status", method: "PATCH", auth: true, roles: ["support_officer", "super_admin"] },
  { path: "/warranties/123/claims", method: "POST", auth: true },
  { path: "/dashboard/queue", method: "GET", auth: true },
  { path: "/products", method: "POST", auth: true, roles: ["product_admin", "super_admin"] },
  { path: "/products/123", method: "PATCH", auth: true, roles: ["product_admin", "super_admin"] },
  { path: "/products/123", method: "DELETE", auth: true, roles: ["product_admin", "super_admin"] },
  { path: "/products/variants", method: "POST", auth: true, roles: ["product_admin", "super_admin"] },
  { path: "/products/variants/123", method: "PATCH", auth: true, roles: ["product_admin", "super_admin"] },
];

function generateToken(userId, role, expiresIn = "1h") {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn });
}

async function testRoute(route, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(`${API_URL}${route.path}`, {
      method: route.method,
      headers,
    });
    return res.status;
  } catch (err) {
    return "ERR";
  }
}

async function runSweep() {
  console.log(`\n🚀 Starting Negative Auth Sweep against ${API_URL}\n`);
  console.log("| Route | Method | No Token (401) | Expired Token (401) | Wrong Role (403) |");
  console.log("|-------|--------|----------------|--------------------|------------------|");

  const expiredToken = generateToken("user123", "customer", "-1h");
  const customerToken = generateToken("user123", "customer", "1h");

  for (const route of routes) {
    const noTokenStatus = await testRoute(route);
    const expiredTokenStatus = await testRoute(route, expiredToken);
    
    let wrongRoleStatus = "N/A";
    if (route.roles && !route.roles.includes("customer")) {
      wrongRoleStatus = await testRoute(route, customerToken);
    }

    console.log(`| ${route.path} | ${route.method} | ${noTokenStatus} | ${expiredTokenStatus} | ${wrongRoleStatus} |`);
  }
  
  console.log("\n✅ Sweep completed.\n");
}

runSweep();
