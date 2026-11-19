import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * Astryx trial: an empty list inside a panel (DESIGN_RULES §10). Two left-aligned
 * lines — what is missing, then the next step — instead of Astryx EmptyState,
 * which centres a bold block and would be the one centred thing on a left-aligned
 * ledger screen. `next` is null for a role that cannot take the step: its
 * RoleGate notice already says who does it, so the same fact is not said twice.
 * The role check is display only; the API decides.
 */
export function EmptyNote({ title, next }: { title: string; next: string | null }) {
  return (
    <VStack gap={0.5}>
      <Text as="p" weight="semibold">{title}</Text>
      {next ? <Text as="p" type="supporting">{next}</Text> : null}
    </VStack>
  );
}
