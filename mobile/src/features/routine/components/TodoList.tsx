import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

import type { Todo } from '../types';

// 준비물 체크 (.todo) — 챙긴 것은 흐리게 줄을 그음
export function TodoList({ todos, onToggle }: { todos: Todo[]; onToggle: (id: string) => void }) {
  if (!todos.length) {
    return (
      <Text variant="note" tone="sub" style={styles.empty}>
        챙길 준비물이 없어요.
      </Text>
    );
  }
  return (
    <View>
      {todos.map((todo, i) => (
        <Pressable
          key={todo.id}
          onPress={() => onToggle(todo.id)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: todo.done }}
          style={[styles.row, i > 0 && styles.divider]}
        >
          <View style={[styles.box, todo.done && styles.boxOn]}>
            {todo.done ? (
              <Text variant="label" tone="inverse">
                ✓
              </Text>
            ) : null}
          </View>
          <Text variant="body" tone={todo.done ? 'faint' : 'ink'} style={todo.done && styles.done}>
            {todo.title}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  done: { textDecorationLine: 'line-through' },
  empty: { marginVertical: 6 },
});
