import { useState, type KeyboardEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import type { LodyComponentDocument, LodyComponentEvent } from '@lody/shared';
import type { AskUserQuestionCardMode } from '../ask-user-question-card';

const styles = stylex.create({
  card: {
    padding: space[3],
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    borderRadius: radius.large,
    boxShadow: shadow.card,
    backgroundColor: colors.elevatedBackground,
    color: colors.label,
    minWidth: 0,
  },
  theme: (foreground: string, background: string) => ({
    color: foreground,
    backgroundColor: background,
  }),
  heading: { fontWeight: 600 },
  accent: (color: string) => ({ color }),
  text: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace', margin: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  input: { display: 'flex', flexDirection: 'column', gap: space[1] },
  legend: { fontSize: '0.9em', opacity: 0.75 },
});

function chord(event: KeyboardEvent): string {
  const key = event.key
    .toLowerCase()
    .replace(/^arrow/, '')
    .replace('escape', 'esc')
    .replace(' ', 'space');
  return [
    ...(event.ctrlKey ? ['ctrl'] : []),
    ...(event.altKey ? ['alt'] : []),
    ...(event.shiftKey ? ['shift'] : []),
    ...(event.metaKey ? ['meta'] : []),
    key,
  ].join('+');
}

/** Native inputs remain inert data and are answered through the owning permission request. */
export function AgentComponentCard({
  document,
  mode,
}: {
  document: LodyComponentDocument;
  mode: AskUserQuestionCardMode;
}) {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<Map<string, string>>(() => new Map());
  const disabled =
    mode.kind === 'readonly' ||
    !mode.isReady ||
    mode.disabled ||
    mode.isPendingSubmit ||
    mode.isPendingCancel;
  const send = (input: string) => {
    if (disabled || mode.kind !== 'interactive') return;
    const event: LodyComponentEvent = {
      version: 1,
      componentId: document.id,
      revision: document.revision,
      input,
    };
    mode.onSubmit({ event: JSON.stringify(event) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      disabled ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.nativeEvent.isComposing
    )
      return;
    const binding = document.keybindings?.find((item) => item.key.toLowerCase() === chord(event));
    if (!binding) return;
    event.preventDefault();
    event.stopPropagation();
    send(binding.input);
  };
  return (
    <div
      role="region"
      aria-label={document.title}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
      {...stylex.props(
        styles.card,
        document.theme && styles.theme(document.theme.foreground, document.theme.background)
      )}
    >
      <div
        {...stylex.props(styles.heading, document.theme && styles.accent(document.theme.accent))}
      >
        {document.title}
      </div>
      {document.nodes.map((node, index) =>
        node.type === 'text' ? (
          <pre key={index} {...stylex.props(styles.text)}>
            {node.text}
          </pre>
        ) : node.type === 'button' ? (
          <div key={node.id}>
            <Button disabled={disabled} onClick={() => send(node.input)}>
              {node.label}
            </Button>
          </div>
        ) : (
          <form
            key={node.id}
            {...stylex.props(styles.input)}
            onSubmit={(event) => {
              event.preventDefault();
              send(inputs.get(node.id) ?? '');
            }}
          >
            <label htmlFor={`${document.id}-${node.id}`}>{node.label}</label>
            <Input
              id={`${document.id}-${node.id}`}
              value={inputs.get(node.id) ?? ''}
              disabled={disabled}
              maxLength={4096}
              onChange={(event) =>
                setInputs((previous) => new Map(previous).set(node.id, event.target.value))
              }
            />
            <div>
              <Button type="submit" disabled={disabled}>
                {t('chat.send')}
              </Button>
            </div>
          </form>
        )
      )}
      {!!document.keybindings?.length && (
        <div {...stylex.props(styles.legend)}>
          {document.keybindings.map((binding) => `${binding.label} (${binding.key})`).join(' · ')}
        </div>
      )}
      {document.theme && <div {...stylex.props(styles.legend)}>{document.theme.name}</div>}
      {mode.kind === 'interactive' && (
        <div {...stylex.props(styles.controls)}>
          <Button disabled={disabled} onClick={mode.onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
