import { noticeText } from '@/lib/notices';

export function PageNotice({ notice }: { notice: string | string[] | undefined }) {
  const text = noticeText(notice);
  if (!text) return null;
  const tone = notice === 'deduplicated' ? 'notice warn' : 'notice ok';
  return (
    <p className={tone} role="status" data-testid="notice" data-notice={String(notice)}>
      {text}
    </p>
  );
}
