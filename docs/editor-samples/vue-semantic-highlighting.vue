<script setup lang="ts">
import { computed, ref } from "vue";

interface FilterOption {
  id: string;
  label: string;
}

const props = defineProps<{
  title: string;
  initialQuery?: string;
}>();

const options = ref<FilterOption[]>([
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
]);
const activeId = ref("all");
const query = ref(props.initialQuery ?? "");

const visibleOptions = computed(() =>
  options.value.filter((option) =>
    option.label.toLowerCase().includes(query.value.toLowerCase())
  )
);

function selectOption(optionId: string) {
  activeId.value = optionId;
}
</script>

<template>
  <section class="filter-panel">
    <header>
      <h2>{{ props.title }}</h2>
      <input v-model="query" type="text" placeholder="Search options" />
    </header>
    <ul>
      <li v-for="option in visibleOptions" :key="option.id">
        <button
          type="button"
          :class="{ active: option.id === activeId }"
          @click="selectOption(option.id)"
        >
          {{ option.label }}
        </button>
      </li>
    </ul>
  </section>
</template>
