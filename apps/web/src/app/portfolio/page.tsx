"use client";
import { ReceivableList } from "@/features/receivable-list";
import { bankReceivable } from "@/features/todo";
export default function Page() { return <ReceivableList title="매입·상환 현황" subtitle="지정 은행으로 접수된 채권의 매입·상환 상태 · 상환 주체는 구매처입니다" emptyHint="등록 완료된 채권이 접수되면 표시됩니다." classify={bankReceivable} />; }
