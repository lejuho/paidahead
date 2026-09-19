"use client";
import { ReceivableList } from "@/features/receivable-list";
import { buyerReceivable } from "@/features/todo";
export default function Page() { return <ReceivableList title="상환" subtitle="은행이 매입한 채권은 만기에 액면 전액을 상환합니다 (부분 상환 없음)" emptyHint="매입된 채권이 생기면 상환 대상으로 표시됩니다." classify={buyerReceivable} />; }
