"use client";
import { ReceivableList } from "@/features/receivable-list";
import { supplierReceivable } from "@/features/todo";
export default function Page() { return <ReceivableList title="채권 · 먼저받기" subtitle="등록된 채권의 은행 조건과 매입 결과" emptyHint="구매처 확인이 끝나면 채권이 등록되어 여기에 표시됩니다." classify={supplierReceivable} />; }
