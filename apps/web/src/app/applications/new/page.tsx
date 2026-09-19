"use client";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ApplicationForm } from "@/features/application-form";
import { PageHead } from "@/components/ui";

export default function NewApplication() {
  const router = useRouter();
  return (<><PageHead title="새 먼저받기 신청" subtitle="받을 돈과 만기, 구매처를 확인하고 서류를 고르세요." back={{ href: "/applications", label: "내 신청" }} />
    <ApplicationForm submitLabel="신청 만들기" onSubmit={async (input) => { const created = await api<{ id: string }>("/applications", input); router.push(`/applications/${created.id}`); }} /></>);
}
