import PrivateConversation from "../../PrivateConversation";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PrivateConversation key={id} conversationId={id} />;
}
