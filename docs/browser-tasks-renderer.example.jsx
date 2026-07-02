// Drop-in renderer for "browser tasks" (AI actions shown in the Oxy PWA).
//
// The backend (enrichActionForBrowser) now sends rich fields so you don't have
// to parse raw action objects.
//
// Usage (in your index.html React):
//   <BrowserTaskList
//     tasks={message.actions || message.tasks || []}
//     onConfirm={task => confirmPendingAction(task)}
//     onDismiss={task => cancelPendingAction(task)}
//   />
//
// Style the .browser-tasks class in your CSS for full control.

function BrowserTaskList({ tasks = [], onConfirm, onDismiss, compact = false }) {
  if (!tasks?.length) return null;

  return (
    <div className="browser-tasks" style={styles.container}>
      {!compact && (
        <div style={styles.header}>
          <span>Tasks</span>
          <span style={styles.count}>{tasks.length}</span>
        </div>
      )}

      <div style={styles.list}>
        {tasks.map((task, i) => {
          const key = task.id || task.action + '-' + i;
          const isPending = task.status === 'pending' || task.isPendingReview;
          const isError = task.status === 'error';
          const isSuccess = task.status === 'success';

          return (
            <div key={key} style={styles.item}>
              <div style={styles.icon}>{task.icon || '•'}</div>

              <div style={styles.content}>
                <div style={{
                  ...styles.title,
                  color: isError ? '#ff6b6b' : isSuccess ? '#69db7c' : '#ddd'
                }}>
                  {task.displayTitle || task.label || task.action}
                </div>

                {task.summary && (
                  <div style={styles.summary}>
                    {task.summary}
                  </div>
                )}

                {task.outcome && task.outcome !== task.summary && (
                  <div style={styles.outcome}>{task.outcome}</div>
                )}
              </div>

              <div style={styles.meta}>
                <span style={{
                  ...styles.badge,
                  background: isPending ? '#2b2b00' : isError ? '#3a1f1f' : '#1f3a1f',
                  color: isPending ? '#ffec8b' : isError ? '#ff8a8a' : '#8aff8a'
                }}>
                  {task.status || (isPending ? 'pending' : 'done')}
                </span>

                {isPending && (
                  <div style={styles.actions}>
                    {onConfirm && (
                      <button style={styles.btn} onClick={() => onConfirm(task)}>
                        Confirm
                      </button>
                    )}
                    {onDismiss && (
                      <button style={styles.btnSecondary} onClick={() => onDismiss(task)}>
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  container: {
    marginTop: 10,
    border: '1px solid #2a2a2a',
    borderRadius: 10,
    background: '#0f0f0f',
    fontSize: 13,
    overflow: 'hidden'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    fontSize: 11,
    color: '#888',
    borderBottom: '1px solid #222',
    background: '#161616'
  },
  count: {
    background: '#222',
    padding: '1px 6px',
    borderRadius: 999,
    fontSize: 10
  },
  list: {
    display: 'flex',
    flexDirection: 'column'
  },
  item: {
    display: 'flex',
    gap: 10,
    padding: '8px 10px',
    borderBottom: '1px solid #1a1a1a',
    alignItems: 'flex-start'
  },
  icon: {
    fontSize: 16,
    width: 22,
    flexShrink: 0,
    marginTop: 1
  },
  content: {
    flex: 1,
    minWidth: 0
  },
  title: {
    fontWeight: 600,
    lineHeight: 1.3
  },
  summary: {
    color: '#aaa',
    marginTop: 3,
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  outcome: {
    fontSize: 11,
    color: '#777',
    marginTop: 2
  },
  meta: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4,
    marginLeft: 6,
    flexShrink: 0
  },
  badge: {
    fontSize: 10,
    padding: '1px 7px',
    borderRadius: 999,
    whiteSpace: 'nowrap'
  },
  actions: {
    display: 'flex',
    gap: 4
  },
  btn: {
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    border: '1px solid #444',
    background: '#222',
    color: '#ddd',
    cursor: 'pointer'
  },
  btnSecondary: {
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    border: '1px solid #333',
    background: 'transparent',
    color: '#999',
    cursor: 'pointer'
  }
};

export default BrowserTaskList;
