import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

interface J3QuickPromptPreset {
  readonly id: string;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly prompt: string;
}

export function J3QuickPromptsBar(props: {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly onSelectPrompt: (prompt: string) => void;
}) {
  const gt = useGT();
  const [collapsed, setCollapsed] = useState(false);

  if (!props.visible) {
    return null;
  }

  const presets: ReadonlyArray<J3QuickPromptPreset> = [
    {
      id: "continue",
      icon: "play",
      label: gt("Continue"),
      prompt: gt("Continue with the next step."),
    },
    {
      id: "tests",
      icon: "flask",
      label: gt("Run tests"),
      prompt: gt("Run the tests and report any failures."),
    },
    {
      id: "diff",
      icon: "file.diff",
      label: gt("Summarize diff"),
      prompt: gt("Summarize the current changes and git diff."),
    },
    {
      id: "fix",
      icon: "wrench.and.screwdriver",
      label: gt("Fix error"),
      prompt: gt("Investigate the latest error and fix the root cause."),
    },
    {
      id: "commit",
      icon: "git.commit",
      label: gt("Review & commit"),
      prompt: gt("Review the changes, run checks, and prepare a clean commit."),
    },
  ];

  const handlePress = (preset: J3QuickPromptPreset) => {
    if (props.disabled) return;
    void Haptics.selectionAsync();
    props.onSelectPrompt(preset.prompt);
  };

  if (collapsed) {
    return (
      <View className="mb-1.5 flex-row justify-start px-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Show quick prompts")}
          onPress={() => setCollapsed(false)}
          className="flex-row items-center gap-1 rounded-full border border-border-subtle bg-card/90 px-2.5 py-1"
        >
          <SymbolView
            name="bolt.circle"
            size={12}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {gt("Quick prompts")}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="mb-1.5 flex-row items-center gap-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Hide quick prompts")}
        onPress={() => setCollapsed(true)}
        className="size-7 items-center justify-center rounded-full border border-border-subtle bg-card/90"
      >
        <SymbolView
          name="bolt.circle"
          size={13}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </Pressable>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingRight: 8 }}
      >
        {presets.map((preset) => (
          <Pressable
            key={preset.id}
            accessibilityRole="button"
            accessibilityLabel={preset.label}
            disabled={props.disabled}
            onPress={() => handlePress(preset)}
            className="flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-card/95 px-2.5 py-1 active:opacity-75"
          >
            <SymbolView
              name={preset.icon}
              size={12}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
            <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
              {preset.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
