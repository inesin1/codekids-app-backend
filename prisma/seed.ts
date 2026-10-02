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
    where: { staffRoles: { has: Role.ADMIN } },
  });
  if (existing) {
    console.log('Admin already exists');
    return;
  }

  const login = process.env['SEED_ADMIN_LOGIN']?.trim();
  const password = process.env['SEED_ADMIN_PASSWORD'];
  if (!login || !password) {
    throw new Error('SEED_ADMIN_LOGIN and SEED_ADMIN_PASSWORD are required');
  }

  const admin = await prisma.user.create({
    data: {
      login,
      email: process.env['SEED_ADMIN_EMAIL'],
      password: await bcrypt.hash(password, 10),
      firstName: 'Tech',
      lastName: 'Admin',
      staffRoles: [Role.ADMIN],
    },
  });

  console.log(`Admin created: ${admin.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
