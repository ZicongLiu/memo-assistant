import { NextRequest, NextResponse } from "next/server";

// Access gate: set APP_PASSPHRASE env var to protect the app.
// If not set, the app is open (useful for local dev).

const PUBLIC_PATHS = ["/login", "/api/auth-app"];
const COOKIE_NAME = "flowdesk_auth";

async function sessionToken(): Promise<string> {
  const secret = process.env.APP_SECRET ?? "flowdesk-dev-secret";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("flowdesk_authenticated"));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function proxy(req: NextRequest) {
  const passphrase = process.env.APP_PASSPHRASE;
  // No passphrase configured → open access (local dev)
  if (!passphrase) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Allow public paths and static assets through
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next();
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) return NextResponse.next();

  // Validate session cookie
  const session = req.cookies.get(COOKIE_NAME);
  if (session?.value === await sessionToken()) return NextResponse.next();

  // Not authenticated → redirect to login
  const loginUrl = new URL("/login", req.url);
  if (pathname !== "/") loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
