"use client";

import { useState } from "react";

import { Alert, Button, Input, Select } from "@/components/ui";

/**
 * Contact form (prototype).
 *
 * There is no ticketing backend and no email provider on this deployment, so
 * this does not send or store anything. On submit it acknowledges with a
 * reference generated in the browser and says plainly that the message was not
 * dispatched — it never claims an email went out.
 */
export function ContactForm() {
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("Trading");
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (subject.trim() === "" || message.trim() === "") return;
    const ref = `JX-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    setReference(ref);
    setSubject("");
    setMessage("");
  };

  return (
    <form className="jc-stack-lg" style={{ maxWidth: 520 }} onSubmit={submit}>
      <Select id="contact-category" label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
        <option>Trading</option>
        <option>Deposits</option>
        <option>Withdrawals</option>
        <option>Security</option>
        <option>Account</option>
        <option>Other</option>
      </Select>

      <Input id="contact-subject" label="Subject" placeholder="Brief summary" value={subject} onChange={(e) => setSubject(e.target.value)} />

      <div>
        <label htmlFor="contact-message" className="jc-label" style={{ display: "block", marginBottom: "var(--jc-space-2)" }}>
          Message
        </label>
        <textarea
          id="contact-message"
          className="jc-input jc-textarea"
          rows={6}
          placeholder="Describe your question or issue"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {reference ? (
        <Alert tone="success" title={`Received — reference ${reference}`}>
          Thanks. This is a prototype: there is no ticketing or email provider connected, so your message was recorded
          with a reference for the interface but was not actually sent or stored.
        </Alert>
      ) : null}

      <div>
        <Button type="submit" variant="primary" size="lg">
          Send message
        </Button>
      </div>
    </form>
  );
}
