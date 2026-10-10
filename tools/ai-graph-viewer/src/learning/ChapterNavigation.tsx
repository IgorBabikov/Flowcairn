import type { LearningChapterBook } from '../contracts';

export function ChapterNavigation({ book, selectedId, onSelect }: {
  book: LearningChapterBook; selectedId: string | null; onSelect: (chapterId: string) => void;
}) {
  return <nav className="learning-chapter-navigation" aria-label="Главы учебного материала">
    <span className="learning-chapter-navigation__label">Главы</span>
    {book.chapters.map(({ id, chapter }) => <button key={id} type="button" className="game-text-action"
      aria-current={selectedId === id ? 'page' : undefined} onClick={() => onSelect(id)}>
      {chapter.order}. {chapter.title}
    </button>)}
  </nav>;
}
