/*
 * Copyright 2026 Coralogix Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The default VitePress theme plus Coralogix design tokens. `custom.css` is
// imported last so its overrides land after the theme's own stylesheets, which
// matters for the same-specificity rules (e.g. the footer link underline).
//
// Code groups are synced by tab title: choosing `pnpm` in one group switches every
// group on the site that has a `pnpm` tab, and the choice is remembered across pages.
// VitePress keeps each group independent by default. Its own click handler also
// scrolls the clicked tab into view, so the other groups are switched directly here
// rather than by simulating clicks, which would jump the page to each of them.
import { inBrowser, onContentUpdated } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { defineComponent, h } from 'vue'

import './custom.css'

const STORAGE_KEY = 'staghorn:code-group'

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(title: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, title)
  } catch {
    // Private windows and blocked storage: the sync still works on this page.
  }
}

// Checks the tab titled `title` in every group that has one, and shows its block.
function selectEverywhere(title: string): void {
  document.querySelectorAll<HTMLElement>('.vp-code-group').forEach((group) => {
    const inputs = Array.from(group.querySelectorAll<HTMLInputElement>('.tabs input'))
    const index = inputs.findIndex(
      (input) => group.querySelector(`label[for="${input.id}"]`)?.dataset['title'] === title,
    )
    const blocks = group.querySelector('.blocks')?.children
    if (index < 0 || !blocks) {
      return
    }
    inputs[index].checked = true
    Array.from(blocks).forEach((block, i) => block.classList.toggle('active', i === index))
  })
}

if (inBrowser) {
  window.addEventListener('click', (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.matches('.vp-code-group input')) {
      return
    }
    const title = document.querySelector<HTMLElement>(`label[for="${input.id}"]`)?.dataset[
      'title'
    ]
    if (title) {
      remember(title)
      selectEverywhere(title)
    }
  })
}

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    setup() {
      onContentUpdated(() => {
        const title = remembered()
        if (title) {
          selectEverywhere(title)
        }
      })
      return () => h(DefaultTheme.Layout)
    },
  }),
}
