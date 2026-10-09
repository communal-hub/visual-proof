<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const project = ref(null)
onMounted(async () => {
  project.value = await (await fetch(`/api/projects/${route.params.id}`)).json()
})
</script>

<template>
  <main>
    <h1>Project</h1>
    <div v-if="!project" class="spinner">Loading...</div>
    <h2 v-else data-test="project-name">{{ project.name }}</h2>
  </main>
</template>
