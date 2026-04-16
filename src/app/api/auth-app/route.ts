import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const COOKIE_NAME = "flowdesk_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sessionToken(): string {
  const secret = process.env.APP_SECRET ?? "flowdesk-dev-secret";
  return crypto.createHmac("sha256", secret).update("flowdesk_authenticated").digest("hex");
}

export async function POST(req: NextRequest) {
  const { passphrase } = await req.json() as { passphrase?: string };
  const expected = process.env.APP_PASSPHRASE;

  if (!expected) {
    return NextResponse.json({ ok: true }); // no passphrase set — open access
  }
  if (!passphrase || passphrase !== expected) {
    return NextResponse.json({ error: "Incorrect passphrase." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
