<script lang="ts">
  import { onMount } from 'svelte';
  import type { Conversation } from '$lib/db';

  /**
   * The sidebar only ever renders the title and the relative time, so it asks for
   * exactly that instead of the whole record (the full `Conversation` also carries
   * `messages`/`provider`, which never appear here).
   */
  type SidebarConversation = Pick<Conversation, 'id' | 'title' | 'updatedAt'>;

  interface ConversationSidebarProps {
    conversations?: SidebarConversation[];
    activeId?: string | null;
    onSelect?: (id: string) => void;
    onNew?: () => void;
    onDelete?: (id: string) => void;
  }

  let { conversations = [], activeId = null, onSelect = () => {}, onNew = () => {}, onDelete = () => {} }: ConversationSidebarProps = $props();

  let showDeleteConfirm = $state<string | null>(null);

  function handleDelete(id: string, e: Event) {
    e.stopPropagation();
    showDeleteConfirm = id;
  }

  function confirmDelete(id: string, e: Event) {
    // Called as `confirmDelete(conv.id, e)` — the missing `e` param was a type
    // error, and without stopPropagation the confirm click also selected the
    // conversation it was deleting (M8).
    e.stopPropagation();
    onDelete(id);
    showDeleteConfirm = null;
  }

  function formatDate(timestamp?: number): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  }

  function truncateTitle(title: string, maxLength: number = 30): string {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength) + '...';
  }
</script>

<div class="sidebar">
  <div class="sidebar-header">
    <h2>💬 Conversations</h2>
    <button class="new-btn" onclick={onNew} title="New Conversation">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
    </button>
  </div>

  {#if conversations.length === 0}
    <div class="empty-state">
      <p>No conversations yet</p>
      <small>Start a new chat to begin</small>
    </div>
  {:else}
    <div class="conversation-list">
      {#each conversations as conv (conv.id)}
        <div 
          class="conversation-item {activeId === conv.id ? 'active' : ''}"
          onclick={() => onSelect(conv.id)}
        >
          <div class="conv-info">
            <span class="conv-title">{truncateTitle(conv.title)}</span>
            <span class="conv-time">{formatDate(conv.updatedAt)}</span>
          </div>
          
          {#if showDeleteConfirm === conv.id}
            <button 
              class="delete-confirm" 
              onclick={(e) => confirmDelete(conv.id, e)}
              title="Confirm delete"
            >
              ✓
            </button>
          {:else}
            <button 
              class="delete-btn" 
              onclick={(e) => handleDelete(conv.id, e)}
              title="Delete conversation"
            >
              ×
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="sidebar-footer">
    <small>{conversations.length} conversation{conversations.length !== 1 ? 's' : ''}</small>
  </div>
</div>

<style>
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    width: 280px;
    height: 100vh;
    background: rgba(10, 15, 30, 0.95);
    border-right: 1px solid rgba(68, 136, 255, 0.2);
    z-index: 100;
    display: flex;
    flex-direction: column;
    backdrop-filter: blur(20px);
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px;
    border-bottom: 1px solid rgba(68, 136, 255, 0.2);
  }

  .sidebar-header h2 {
    font-size: 18px;
    color: #e0e8ff;
    margin: 0;
  }

  .new-btn {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: rgba(68, 136, 255, 0.1);
    border: 1px solid rgba(68, 136, 255, 0.3);
    color: #4488ff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .new-btn:hover {
    background: rgba(68, 136, 255, 0.3);
    border-color: #4488ff;
    box-shadow: 0 0 15px rgba(68, 136, 255, 0.4);
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    color: #8899bb;
  }

  .empty-state p {
    font-size: 16px;
    margin-bottom: 8px;
  }

  .empty-state small {
    font-size: 13px;
    opacity: 0.7;
  }

  .conversation-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .conversation-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    margin-bottom: 8px;
    background: rgba(68, 136, 255, 0.05);
    border: 1px solid rgba(68, 136, 255, 0.1);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .conversation-item:hover {
    background: rgba(68, 136, 255, 0.1);
    border-color: rgba(68, 136, 255, 0.3);
  }

  .conversation-item.active {
    background: rgba(68, 136, 255, 0.2);
    border-color: #4488ff;
    box-shadow: 0 0 15px rgba(68, 136, 255, 0.3);
  }

  .conv-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;
  }

  .conv-title {
    font-size: 14px;
    color: #e0e8ff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conv-time {
    font-size: 12px;
    color: #667799;
  }

  .delete-btn,
  .delete-confirm {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: rgba(255, 100, 100, 0.1);
    border: 1px solid rgba(255, 100, 100, 0.3);
    color: #ff6464;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .delete-btn:hover {
    background: rgba(255, 100, 100, 0.3);
    border-color: #ff6464;
  }

  .delete-confirm {
    background: rgba(74, 222, 128, 0.1);
    border-color: #4ade80;
    color: #4ade80;
  }

  .delete-confirm:hover {
    background: rgba(74, 222, 128, 0.3);
  }

  .sidebar-footer {
    padding: 16px 20px;
    border-top: 1px solid rgba(68, 136, 255, 0.2);
    text-align: center;
    color: #667799;
  }

  .conversation-list::-webkit-scrollbar {
    width: 4px;
  }

  .conversation-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .conversation-list::-webkit-scrollbar-thumb {
    background: rgba(68, 136, 255, 0.2);
    border-radius: 2px;
  }
</style>
