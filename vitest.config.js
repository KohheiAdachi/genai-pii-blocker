import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 既定の exclude を上書きするため、node_modules と dist も明示する。
    // .claude/worktrees/ 配下には作業中のブランチのコピーが置かれることがあり、
    // 除外しないとリポジトリ本体のテストと一緒に実行されて件数が合わなくなる
    // （古いコードのテストが通ってしまい、結果を読み間違える）
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**']
  }
});
