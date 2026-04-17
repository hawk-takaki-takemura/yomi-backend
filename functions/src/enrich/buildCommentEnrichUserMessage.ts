type CommentSnippet = {
  commentId: number;
  text: string;
};

export function buildCommentEnrichUserMessage(args: {
  storyId: number;
  title: string;
  snippets: CommentSnippet[];
}): string {
  const numbered = args.snippets
    .map((s, i) => `${i + 1}. id:${s.commentId}\n${s.text}`)
    .join("\n\n");

  return [
    `storyId: ${args.storyId}`,
    `記事タイトル: ${args.title}`,
    `以下は分析・翻訳対象のコメント（全${args.snippets.length}件）です。`,
    "",
    numbered,
  ].join("\n");
}
