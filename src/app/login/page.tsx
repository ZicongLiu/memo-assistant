"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (res.ok) {
        const from = searchParams.get("from") ?? "/";
        router.replace(from);
      } else {
        const { error: msg } = await res.json();
        setError(msg ?? "Incorrect passphrase.");
        setPassphrase("");
        inputRef.current?.focus();
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.icon}>🔐</div>
        <h1 style={styles.title}>FlowDesk</h1>
        <p style={styles.sub}>Enter your passphrase to continue</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            ref={inputRef}
            type="password"
            placeholder="Passphrase…"
            value={passphrase}
            onChange={e => { setPassphrase(e.target.value); setError(""); }}
            style={styles.input}
            autoComplete="current-password"
          />
          {error && <div style={styles.error}>{error}</div>}
          <button type="submit" style={styles.btn} disabled={loading || !passphrase.trim()}>
            {loading ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #6d28d9 100%)",
    padding: "16px",
  },
  card: {
    background: "#fff",
    borderRadius: "18px",
    padding: "40px 36px",
    width: "100%",
    maxWidth: "360px",
    boxShadow: "0 20px 60px rgba(30,27,75,0.35)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "12px",
  },
  icon: { fontSize: "2.4rem", lineHeight: 1 },
  title: { margin: 0, fontSize: "1.5rem", fontWeight: 800, color: "#1e1b4b" },
  sub: { margin: 0, fontSize: "0.88rem", color: "#6b7280" },
  form: { width: "100%", display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" },
  input: {
    width: "100%", padding: "11px 14px", fontSize: "1rem",
    border: "1.5px solid #e4e0ff", borderRadius: "10px",
    outline: "none", color: "#1e1b4b", boxSizing: "border-box",
  },
  error: {
    fontSize: "0.82rem", color: "#dc2626",
    background: "#fef2f2", border: "1px solid #fca5a5",
    borderRadius: "8px", padding: "8px 12px",
  },
  btn: {
    padding: "11px", fontSize: "0.95rem", fontWeight: 700,
    background: "#6d28d9", color: "#fff", border: "none",
    borderRadius: "10px", cursor: "pointer", transition: "opacity 0.15s",
  },
};
