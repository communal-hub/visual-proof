<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

// Rows navigate by click handler: no <a href> for link discovery to find.
const router = useRouter()
const projects = ref(null)
onMounted(async () => {
  projects.value = await (await fetch('/api/projects')).json()
})
const open = (id) => router.push(`/manage/projects/${id}`)
</script>

<template>
  <main>
    <h1>Projects</h1>
    <div v-if="!projects" class="spinner">Loading...</div>
    <ul v-else data-test="project-list">
      <li v-for="project in projects" :key="project.id" @click="open(project.id)">{{ project.name }}</li>
    </ul>
  </main>
</template>
