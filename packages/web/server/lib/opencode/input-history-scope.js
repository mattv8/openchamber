export const DEFAULT_INPUT_HISTORY_SCOPE = 'global';

export const isInputHistoryScope = (value) => (
  value === 'global' || value === 'session'
);
