"use client";
import { useState } from "react";
import { api, codeOf } from "@/lib/api";
import { documentType, errorMessage } from "@/lib/labels";
import { DemoTag } from "@/components/ui";

export interface DocumentMeta { id: string; document_type: string; original_filename: string; file_hash: string }
/** Evidence is fetched on demand through the API's own permission check. Files are fixed virtual text fixtures. */
export function DocumentList({ documents }: { documents: DocumentMeta[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<Record<string, string>>({});
  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!body[id]) setBody({ ...body, [id]: await api<string>(`/documents/${id}/content`).catch((e) => `⚠ ${errorMessage(codeOf(e))}`) });
  };
  return (<ul className="docs">{documents.map((d) => (
    <li key={d.id}><button type="button" className="doc" onClick={() => toggle(d.id)} aria-expanded={open === d.id}>
      <span><b>{documentType[d.document_type] ?? d.document_type}</b> {d.original_filename} <DemoTag>가상 서류</DemoTag></span>
      <span className="mono" title={`SHA-256 ${d.file_hash}`}>{d.file_hash.slice(0, 10)}…</span></button>
      {open === d.id && <pre className="doc-body">{body[d.id] ?? "불러오는 중…"}</pre>}</li>))}</ul>);
}
