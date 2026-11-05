const en = {
  addCard: 'New card (double-click the board)',
  addGroup: 'New group',
  zoomIn: 'Zoom in (+)',
  zoomOut: 'Zoom out (−)',
  zoomReset: 'Zoom to 100% (Shift+0)',
  fit: 'Show everything (Shift+1)',
  undo: 'Undo (Ctrl+Z)',
  redo: 'Redo (Ctrl+Shift+Z)',
  pin: 'Pin to the top',
  unpin: 'Unpin',
  duplicate: 'Duplicate (Ctrl+D)',
  delete: 'Delete (Del)',
  noColor: 'No color',
  colors: ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Purple'],
  emptyTitle: 'The board is empty',
  emptyHint: 'Ask the agent: “put the goal and the tasks on the board”.\nDouble-click anywhere to add a card yourself.',
  groupDefault: 'Group',
  broken: 'The board file is broken:',
  brokenHint: 'Fix the JSON or press Undo. Nothing is saved until then.',
};

const ru: typeof en = {
  addCard: 'Новая карточка (двойной клик по доске)',
  addGroup: 'Новая группа',
  zoomIn: 'Приблизить (+)',
  zoomOut: 'Отдалить (−)',
  zoomReset: 'Масштаб 100% (Shift+0)',
  fit: 'Показать всё (Shift+1)',
  undo: 'Отменить (Ctrl+Z)',
  redo: 'Повторить (Ctrl+Shift+Z)',
  pin: 'Закрепить сверху',
  unpin: 'Открепить',
  duplicate: 'Дублировать (Ctrl+D)',
  delete: 'Удалить (Del)',
  noColor: 'Без цвета',
  colors: ['Красный', 'Оранжевый', 'Жёлтый', 'Зелёный', 'Голубой', 'Фиолетовый'],
  emptyTitle: 'Доска пуста',
  emptyHint: 'Попросите агента: «выведи на доску цель и задачи».\nДвойной клик по доске — своя карточка.',
  groupDefault: 'Группа',
  broken: 'Файл доски повреждён:',
  brokenHint: 'Исправьте JSON или нажмите «Отменить». До этого ничего не сохраняется.',
};

export let t = en;

export function setLang(lang: string): void {
  t = lang === 'ru' ? ru : en;
}
