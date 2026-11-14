import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

/**
 * Portfolio projects. Add a project by dropping a Markdown file into
 * src/content/work/ and its screenshots into src/assets/work/.
 * See README → "Adding a project".
 */
const work = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/work' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      /** Who the site is for, e.g. 'Vishwa Sports Academy'. */
      client: z.string(),
      /** Honest description of the relationship, e.g. 'Built for a karate academy' or 'Studio project'. */
      relationship: z.string(),
      summary: z.string(),
      /** Filters on /work/. Use the values in `categories` below. */
      categories: z.array(z.enum(['Business', 'Restaurant & café', 'Portfolio', 'Landing page', 'Redesign'])).min(1),
      services: z.array(z.string()),
      stack: z.array(z.string()).default([]),
      year: z.string(),
      status: z.enum(['Live', 'Preview', 'In development']),
      /** Optional note shown beside the status, e.g. why it's a preview. */
      statusNote: z.string().optional(),
      url: z.url().or(z.literal('')).default(''),
      /** Brand colour of the project, used for accents on its card and page. */
      color: z.string().default('#111110'),
      /** Desktop screenshot, 1600×1000 works best. */
      cover: image(),
      coverAlt: z.string(),
      /** Optional phone screenshot, 390×844 at 2x works best. */
      mobile: image().optional(),
      mobileAlt: z.string().optional(),
      /** Optional extra desktop screenshot for the case study. */
      detail: image().optional(),
      detailAlt: z.string().optional(),
      /** Lower numbers appear first. */
      order: z.number().default(100),
      featured: z.boolean().default(true),
      /** Set to true to hide a project without deleting it. */
      draft: z.boolean().default(false),
    }),
})

export const collections = { work }
