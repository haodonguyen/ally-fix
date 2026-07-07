"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/** URL-input form. On success it redirects to the audit's report page. */
export function ScanForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/audits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data: { auditId?: string; error?: string } = await response.json();
      if (!response.ok || !data.auditId) {
        setError(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      router.push(`/audits/${data.auditId}`);
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "2rem" }}>
      <label htmlFor="url" style={{ display: "block", fontWeight: 600, marginBottom: "0.5rem" }}>
        Page URL
      </label>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input
          id="url"
          name="url"
          type="url"
          required
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-describedby={error ? "url-error" : undefined}
          aria-invalid={error ? true : undefined}
          style={{ flex: "1 1 20rem", padding: "0.6rem 0.75rem", fontSize: "1rem" }}
        />
        <button type="submit" disabled={submitting} style={{ padding: "0.6rem 1.25rem" }}>
          {submitting ? "Starting…" : "Scan"}
        </button>
      </div>
      {error && (
        <p id="url-error" role="alert" style={{ color: "#b00020", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
    </form>
  );
}
