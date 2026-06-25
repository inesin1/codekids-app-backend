import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '../src/generated/client';

const adapter = new PrismaPg({
  connectionString: process.env['DATABASE_URL']!,
});
const prisma = new PrismaClient({ adapter });

const COURSES = [
  'Scratch',
  'Roblox',
  'Unity',
  'GameMaker Studio 2',
  'Python',
  'Tilda',
  'HTML/CSS/JS',
  '3D моделирование',
  'Английский',
];

async function seedCourses() {
  const { count } = await prisma.course.createMany({
    data: COURSES.map((name) => ({ name })),
    skipDuplicates: true,
  });
  console.log(`Courses seeded: ${count} new, ${COURSES.length} total`);
}

async function main() {
  await seedCourses();

  const existing = await prisma.user.findFirst({
    where: { roles: { has: Role.ADMIN } },
  });
  if (existing) {
    console.log(`Admin already exists: ${existing.email}`);
    return;
  }

  const admin = await prisma.user.create({
    data: {
      email: 'tech.admin@codekids.cc',
      password: await bcrypt.hash('1Gb128OP', 10),
      firstName: 'Tech',
      lastName: 'Admin',
      roles: [Role.ADMIN],
    },
  });

  console.log(`Admin created: ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
