import type { Metadata } from 'next';
import { ImportConversations } from './ImportConversations';

export const metadata: Metadata = { title: 'Import conversations' };

// #20 conversation import: selected conversations from an official ChatGPT or Claude.ai export.
export default function ImportsPage() {
  return (
    <section>
      <div className="crumbs"><a href="/sources">Sources</a></div>
      <h1>Import conversations</h1>
      <p className="lede">
        Choose conversations from a ChatGPT or Claude.ai data export. Each selected conversation becomes one source, kept unchanged with every
        message&apos;s role and time. Assistant messages are attributed to the assistant, never to you; nothing becomes a record until you
        create and confirm one. Instructions inside a conversation are treated as data and never run.
      </p>
      <ImportConversations />
    </section>
  );
}
